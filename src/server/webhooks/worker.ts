import { and, asc, eq, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { WEBHOOK_PAUSE_AFTER } from "../../shared/schemas.js";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import {
  deliveryKeyRefusal,
  isPending,
  leftFollowedProjects,
  type WebhookSettings,
} from "../service/webhooks.js";
import {
  buildEnvelope,
  buildMessageEnvelope,
  type Envelope,
} from "./payload.js";
import { openSecret } from "./secret.js";
import { type SendResult, sendWebhook } from "./send.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Waits before the 2nd, 3rd, ... attempt of a delivery; the last repeats. */
export const BACKOFF_MS = [
  10_000,
  30_000,
  2 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  4 * HOUR,
];
/** A delivery still failing this long after it was queued, time paused not counted, is marked failed. */
export const GIVE_UP_MS = 24 * HOUR;
export const POLL_MS = 5_000;
/** Delivered rows are kept this long after delivery, failed ones this long after they were queued: a bot's history to debug from. */
export const DELIVERED_KEEP_MS = 7 * 24 * HOUR;
export const FAILED_KEEP_MS = 30 * 24 * HOUR;
export const PURGE_MS = 10 * MINUTE;
export const PURGE_BATCH = 500;
/** The lastError of a delivery the worker drops instead of sending. */
export const LEFT_PROJECT =
  "not sent: the item left the projects this webhook follows before it went out";

export type WebhookWorkerOptions = {
  db: Db;
  bus: EventBus;
  settings: WebhookSettings;
  backoffMs?: number[];
  giveUpMs?: number;
  pauseAfter?: number;
  pollMs?: number;
  deliveredKeepMs?: number;
  failedKeepMs?: number;
  purgeMs?: number;
  purgeBatch?: number;
};

type Delivery = typeof webhookDelivery.$inferSelect;
type Subscription = typeof webhookSubscription.$inferSelect;

/** updated_at is the bot's own changes; a delivery attempt writes the subscription but isn't one, and the column's on-update default would stamp it. */
const keepUpdatedAt = sql`${webhookSubscription.updatedAt}`;

/**
 * Each unpaused subscription's oldest pending delivery, due or not, in seq order
 * (one event's deliveries in the order they were queued).
 * Driven from the subscriptions, one index probe each: a paused subscription's
 * backlog only grows, and a query driven from the deliveries reads all of it.
 */
/** Marks failed the pending deliveries of unpaused subscriptions created before `cutoff`. */
export function expireQuery(db: Db, cutoff: number, subscriptionId?: string) {
  return db
    .update(webhookDelivery)
    .set({
      status: "failed",
      lastError: sql`coalesce(${webhookDelivery.lastError}, 'not delivered within the retry window')`,
    })
    .where(
      and(
        isPending,
        subscriptionId === undefined
          ? undefined
          : eq(webhookDelivery.subscriptionId, subscriptionId),
        lt(webhookDelivery.createdAt, new Date(cutoff)),
        sql`${webhookDelivery.subscriptionId} in (select id from webhook_subscription where paused_at is null)`,
      ),
    );
}

/** The deletes of up to `limit` finished deliveries past their keep time: delivered ones, then failed ones. */
export function purgeQueries(
  db: Db,
  now: number,
  keep: { deliveredMs: number; failedMs: number },
  limit: number,
) {
  // the status as a literal, so the planner matches the partial indexes; ordered
  // by the indexed age, oldest first, or statistics that see mostly old rows
  // turn the LIMIT into a table scan under the write lock
  const ids = (where: SQL | undefined, age: SQLiteColumn) =>
    db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(where)
      .orderBy(asc(age))
      .limit(limit);
  return [
    ids(
      and(
        sql`${webhookDelivery.status} = 'delivered'`,
        lt(webhookDelivery.deliveredAt, new Date(now - keep.deliveredMs)),
      ),
      webhookDelivery.deliveredAt,
    ),
    ids(
      and(
        sql`${webhookDelivery.status} = 'failed'`,
        lt(webhookDelivery.createdAt, new Date(now - keep.failedMs)),
      ),
      webhookDelivery.createdAt,
    ),
  ].map((rows) =>
    db.delete(webhookDelivery).where(inArray(webhookDelivery.id, rows)),
  );
}

/** Deletes up to `limit` finished deliveries of each kind past their keep time; returns how many went. */
export function purgeBatch(
  db: Db,
  now: number,
  keep: { deliveredMs: number; failedMs: number },
  limit: number,
): number {
  return purgeQueries(db, now, keep, limit).reduce(
    (removed, query) => removed + query.run().changes,
    0,
  );
}

export function headsQuery(db: Db, subscriptionId?: string) {
  return db
    .select({ delivery: webhookDelivery })
    .from(webhookSubscription)
    .innerJoin(
      webhookDelivery,
      // 'pending' as a literal, so the planner can match the partial index
      eq(
        webhookDelivery.id,
        sql`(select x.id from webhook_delivery x where x.subscription_id = ${webhookSubscription.id} and x.status = 'pending' order by x.seq, x.rowid limit 1)`,
      ),
    )
    .where(
      and(
        isNull(webhookSubscription.pausedAt),
        subscriptionId === undefined
          ? undefined
          : eq(webhookSubscription.id, subscriptionId),
      ),
    )
    .orderBy(asc(webhookDelivery.seq));
}

/**
 * Sends the outbox. The outbox rows are written with the events, so this only
 * has to find them: the bus wakes it for a new event, a poll finds retries that
 * came due and whatever a restart left behind. Each subscription's deliveries
 * go out one at a time in event order, so a delivery that is retrying holds the
 * ones behind it. Delivery is at least once: a crash between the receiver's
 * answer and the row's update sends that delivery again, under the same id.
 */
export function createWebhookWorker(options: WebhookWorkerOptions) {
  const { db, bus, settings } = options;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const giveUpMs = options.giveUpMs ?? GIVE_UP_MS;
  const pauseAfter = options.pauseAfter ?? WEBHOOK_PAUSE_AFTER;
  const pollMs = options.pollMs ?? POLL_MS;
  const keep = {
    deliveredMs: options.deliveredKeepMs ?? DELIVERED_KEEP_MS,
    failedMs: options.failedKeepMs ?? FAILED_KEEP_MS,
  };
  const purgeMs = options.purgeMs ?? PURGE_MS;
  const batch = options.purgeBatch ?? PURGE_BATCH;

  /** each subscription with a run in flight; a subscription never has two, so its order holds */
  const runs = new Map<string, Promise<void>>();
  let woken = false;
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let purgeTimer: NodeJS.Timeout | null = null;
  let purging: Promise<void> | null = null;
  const abort = new AbortController();
  /** deliveries whose crash couldn't be recorded, by id: not tried again before `until` */
  const held = new Map<string, { crashes: number; until: number }>();

  /** Fails what an unpaused subscription couldn't deliver in the window; a paused one's deliveries wait. */
  function expire(now: number, subscriptionId?: string) {
    expireQuery(db, now - giveUpMs, subscriptionId).run();
  }

  /** Each unpaused subscription's oldest pending delivery, when it is due. */
  function dueHeads(now: number, subscriptionId?: string): Delivery[] {
    return headsQuery(db, subscriptionId)
      .all()
      .map((h) => h.delivery)
      .filter((d) => d.nextAttemptAt.getTime() <= now);
  }

  /** The envelope a delivery carries: its message's on an inbox subscription, else its event's. */
  function envelopeOf(delivery: Delivery): Envelope | undefined {
    if (delivery.messageId !== null) {
      return buildMessageEnvelope(db, delivery.messageId);
    }
    if (delivery.eventId === null) return undefined;
    const event = db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.id, delivery.eventId))
      .get();
    return event && buildEnvelope(db, event, settings.publicUrl);
  }

  function bodyOf(delivery: Delivery): string | null {
    if (delivery.body !== null) return delivery.body;
    const envelope = envelopeOf(delivery);
    if (!envelope) return null;
    const body = JSON.stringify({
      ...envelope,
      // a product event's legacy trail.project.* twin carries its own type
      type: delivery.type,
    });
    db.update(webhookDelivery)
      .set({ body })
      .where(eq(webhookDelivery.id, delivery.id))
      .run();
    return body;
  }

  function record(delivery: Delivery, result: SendResult, now: number) {
    const attempts = delivery.attempts + 1;
    db.transaction(
      (tx) => {
        if (result.ok) {
          tx.update(webhookDelivery)
            .set({
              status: "delivered",
              // delivered: nothing sends it again, so its bytes go
              body: null,
              attempts,
              lastStatus: result.status,
              lastError: null,
              deliveredAt: new Date(now),
            })
            .where(eq(webhookDelivery.id, delivery.id))
            .run();
          tx.update(webhookSubscription)
            .set({
              lastSuccessAt: new Date(now),
              consecutiveFailures: 0,
              updatedAt: keepUpdatedAt,
            })
            .where(eq(webhookSubscription.id, delivery.subscriptionId))
            .run();
          return;
        }
        const wait = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 0;
        const giveUp =
          !result.retryable ||
          now + wait > delivery.createdAt.getTime() + giveUpMs;
        tx.update(webhookDelivery)
          .set({
            status: giveUp ? "failed" : "pending",
            attempts,
            lastStatus: result.status,
            lastError: result.error,
            nextAttemptAt: new Date(now + wait),
          })
          .where(eq(webhookDelivery.id, delivery.id))
          .run();
        // SET expressions all read the row as it was, so both see the count before this failure
        tx.update(webhookSubscription)
          .set({
            consecutiveFailures: sql`${webhookSubscription.consecutiveFailures} + 1`,
            lastError: result.error,
            lastErrorAt: new Date(now),
            updatedAt: keepUpdatedAt,
            pausedAt: sql`case when ${webhookSubscription.pausedAt} is null and ${webhookSubscription.consecutiveFailures} + 1 >= ${pauseAfter} then ${now} else ${webhookSubscription.pausedAt} end`,
          })
          .where(eq(webhookSubscription.id, delivery.subscriptionId))
          .run();
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Why a delivery mustn't go out now, or null: its event's item has left
   * the project a follow alone queued it for, or the webhook's key can no
   * longer send it (`deliveryKeyRefusal`). `tell` is set on the key's refusals,
   * which only the bot can fix.
   */
  function unsendable(
    delivery: Delivery,
    sub: Subscription,
  ): { reason: string; tell: boolean } | null {
    const keyRefused = (event: typeof activityEvent.$inferSelect | null) => {
      const reason = deliveryKeyRefusal(db, sub, event);
      return reason === null ? null : { reason, tell: true };
    };
    if (delivery.eventId === null) return keyRefused(null);
    const event = db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.id, delivery.eventId))
      .get();
    if (!event) return null;
    if (leftFollowedProjects(db, sub.id, event))
      return { reason: LEFT_PROJECT, tell: false };
    return keyRefused(event);
  }

  /**
   * Marks the delivery failed with `reason`, without an attempt and keeping
   * no body. The receiver had no part in it, so nothing counts toward a pause;
   * with `tell` the webhook's own lastError carries the reason, the only one
   * its bot can read.
   */
  function drop(
    delivery: Delivery,
    { reason, tell }: { reason: string; tell: boolean },
  ) {
    db.transaction(
      (tx) => {
        const dropped = tx
          .update(webhookDelivery)
          .set({ status: "failed", body: null, lastError: reason })
          .where(and(eq(webhookDelivery.id, delivery.id), isPending))
          .run();
        if (!tell || dropped.changes === 0) return;
        tx.update(webhookSubscription)
          .set({
            lastError: reason,
            lastErrorAt: new Date(settings.now()),
            updatedAt: keepUpdatedAt,
          })
          .where(eq(webhookSubscription.id, delivery.subscriptionId))
          .run();
      },
      { behavior: "immediate" },
    );
  }

  async function attempt(delivery: Delivery) {
    const sub = db
      .select()
      .from(webhookSubscription)
      .where(eq(webhookSubscription.id, delivery.subscriptionId))
      .get();
    if (!sub) return;
    const refused = unsendable(delivery, sub);
    if (refused !== null) {
      drop(delivery, refused);
      return;
    }
    const secret = openSecret(settings.key, sub.id, sub.secretCipher);
    const body = secret === null ? null : bodyOf(delivery);
    let result: SendResult;
    if (secret === null) {
      result = {
        ok: false,
        status: null,
        error:
          "the stored secret can't be read: set a new one with rotate_webhook_secret",
        retryable: true,
      };
    } else if (body === null) {
      result = {
        ok: false,
        status: null,
        error: "the event or message is gone",
        retryable: false,
      };
    } else {
      result = await sendWebhook(
        settings,
        { url: sub.url, secret, deliveryId: delivery.id, body },
        abort.signal,
      );
    }
    // a shutdown aborts the request: the delivery stays pending for the next start
    if (abort.signal.aborted) return;
    record(delivery, result, settings.now());
    held.delete(delivery.id);
  }

  /**
   * Turns a throw inside an attempt into a retryable failure, so the backoff
   * applies; when even that can't be written the delivery is held here instead,
   * or the next round would pick it straight back up.
   */
  function crashed(delivery: Delivery, error: unknown) {
    console.error("webhook delivery crashed", delivery.id, error);
    const now = settings.now();
    try {
      record(
        delivery,
        { ok: false, status: null, error: "internal error", retryable: true },
        now,
      );
      held.delete(delivery.id);
    } catch (recordError) {
      console.error(
        "webhook delivery crash not recorded",
        delivery.id,
        recordError,
      );
      const crashes = (held.get(delivery.id)?.crashes ?? 0) + 1;
      const wait = backoff[Math.min(crashes - 1, backoff.length - 1)] ?? 0;
      held.set(delivery.id, { crashes, until: now + wait });
    }
  }

  function due(now: number, subscriptionId?: string): Delivery[] {
    expire(now, subscriptionId);
    return dueHeads(now, subscriptionId).filter(
      (d) => (held.get(d.id)?.until ?? 0) <= now,
    );
  }

  /** Sends one subscription's queue in order, a delivery at a time, until its head isn't due. */
  async function run(first: Delivery) {
    const id = first.subscriptionId;
    try {
      let next: Delivery | undefined = first;
      while (next) {
        const delivery: Delivery = next;
        await attempt(delivery).catch((error) => crashed(delivery, error));
        // a macrotask turn between attempts, so a run can never starve the event loop
        await new Promise((done) => setImmediate(done));
        if (abort.signal.aborted) return;
        next = due(settings.now(), id)[0];
      }
    } catch (error) {
      console.error("webhook pass failed", error);
    } finally {
      // in the same turn as the last lookup, so a pass can't skip a head this run didn't see
      runs.delete(id);
    }
  }

  /**
   * Starts a run for each subscription with a due head and none in flight;
   * resolves when every run is done. Never rejects.
   */
  function tick(): Promise<void> {
    if (!abort.signal.aborted) {
      try {
        for (const head of due(settings.now())) {
          if (!runs.has(head.subscriptionId)) {
            runs.set(head.subscriptionId, run(head));
          }
        }
      } catch (error) {
        console.error("webhook pass failed", error);
      }
    }
    return Promise.all(runs.values()).then(() => {});
  }

  /** A pass after the current turn, so a bus event's publisher never runs the worker's queries; wakes coalesce. */
  function wake() {
    if (woken) return;
    woken = true;
    setImmediate(() => {
      woken = false;
      void tick();
    });
  }

  /**
   * Deletes finished deliveries past their keep time, a small batch at a time
   * with a macrotask turn between, so a large backlog of them never holds the
   * database or the event loop. Never rejects.
   */
  function purge(): Promise<void> {
    if (purging) return purging;
    // .finally runs a microtask later, so it clears after the assignment even when the pass never awaits
    const pass = purgePass().finally(() => {
      purging = null;
    });
    purging = pass;
    return pass;
  }

  async function purgePass() {
    try {
      while (!abort.signal.aborted) {
        if (purgeBatch(db, settings.now(), keep, batch) < batch) break;
        await new Promise((done) => setImmediate(done));
      }
    } catch (error) {
      console.error("webhook purge failed", error);
    }
  }

  return {
    tick,
    purge,
    /** Starts listening to the bus and polling; the first pass sends whatever an earlier run left. */
    start() {
      if (!stopped) return;
      stopped = false;
      const fromEvents = bus.subscribe((_: ActivityEvent) => wake());
      const fromMessages = bus.subscribeMessages(() => wake());
      unsubscribe = () => {
        fromEvents();
        fromMessages();
      };
      timer = setInterval(() => void tick(), pollMs);
      timer.unref();
      purgeTimer = setInterval(() => void purge(), purgeMs);
      purgeTimer.unref();
      void tick();
      void purge();
    },
    /** Stops sending, cuts requests in flight (their deliveries stay pending) and waits for every run to end. */
    async stop() {
      stopped = true;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      if (purgeTimer) clearInterval(purgeTimer);
      abort.abort();
      await Promise.all([...runs.values(), purging]);
    },
  };
}

export type WebhookWorker = ReturnType<typeof createWebhookWorker>;
