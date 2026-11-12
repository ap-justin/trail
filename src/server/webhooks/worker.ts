import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import type { WebhookSettings } from "../service/webhooks.js";
import { buildEnvelope } from "./payload.js";
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
/** A delivery still failing this long after its event is marked failed. */
export const GIVE_UP_MS = 24 * HOUR;
/** Consecutive failed attempts, across a subscription's deliveries, that pause it. */
export const PAUSE_AFTER = 8;
export const POLL_MS = 5_000;

export type WebhookWorkerOptions = {
  db: Db;
  bus: EventBus;
  settings: WebhookSettings;
  backoffMs?: number[];
  giveUpMs?: number;
  pauseAfter?: number;
  pollMs?: number;
};

type Delivery = typeof webhookDelivery.$inferSelect;

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
  const pauseAfter = options.pauseAfter ?? PAUSE_AFTER;
  const pollMs = options.pollMs ?? POLL_MS;

  let running: Promise<void> | null = null;
  let again = false;
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const abort = new AbortController();

  function expire(now: number) {
    db.update(webhookDelivery)
      .set({
        status: "failed",
        lastError: sql`coalesce(${webhookDelivery.lastError}, 'not delivered within the retry window')`,
      })
      .where(
        and(
          eq(webhookDelivery.status, "pending"),
          lt(webhookDelivery.createdAt, new Date(now - giveUpMs)),
        ),
      )
      .run();
  }

  /** Each unpaused subscription's oldest pending delivery, when it is due. */
  function dueHeads(now: number): Delivery[] {
    const heads = db
      .select({ delivery: webhookDelivery })
      .from(webhookDelivery)
      .innerJoin(
        webhookSubscription,
        eq(webhookSubscription.id, webhookDelivery.subscriptionId),
      )
      .where(
        and(
          eq(webhookDelivery.status, "pending"),
          sql`${webhookSubscription.pausedAt} is null`,
          sql`${webhookDelivery.seq} = (select min(d.seq) from webhook_delivery d where d.subscription_id = ${webhookDelivery.subscriptionId} and d.status = 'pending')`,
        ),
      )
      .orderBy(asc(webhookDelivery.seq))
      .all();
    return heads
      .map((h) => h.delivery)
      .filter((d) => d.nextAttemptAt.getTime() <= now);
  }

  function bodyOf(delivery: Delivery): string | null {
    if (delivery.body !== null) return delivery.body;
    const event = db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.id, delivery.eventId))
      .get();
    if (!event) return null;
    const body = JSON.stringify(buildEnvelope(db, event, settings.publicUrl));
    db.update(webhookDelivery)
      .set({ body })
      .where(eq(webhookDelivery.id, delivery.id))
      .run();
    return body;
  }

  function record(delivery: Delivery, result: SendResult, now: number) {
    const attempts = delivery.attempts + 1;
    db.transaction((tx) => {
      if (result.ok) {
        tx.update(webhookDelivery)
          .set({
            status: "delivered",
            attempts,
            lastStatus: result.status,
            lastError: null,
            deliveredAt: new Date(now),
          })
          .where(eq(webhookDelivery.id, delivery.id))
          .run();
        tx.update(webhookSubscription)
          .set({ lastSuccessAt: new Date(now), consecutiveFailures: 0 })
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
      const failures =
        tx
          .select({ n: webhookSubscription.consecutiveFailures })
          .from(webhookSubscription)
          .where(eq(webhookSubscription.id, delivery.subscriptionId))
          .get()?.n ?? 0;
      tx.update(webhookSubscription)
        .set({
          consecutiveFailures: failures + 1,
          lastError: result.error,
          lastErrorAt: new Date(now),
          ...(failures + 1 >= pauseAfter ? { pausedAt: new Date(now) } : {}),
        })
        .where(eq(webhookSubscription.id, delivery.subscriptionId))
        .run();
    });
  }

  async function attempt(delivery: Delivery) {
    const sub = db
      .select()
      .from(webhookSubscription)
      .where(eq(webhookSubscription.id, delivery.subscriptionId))
      .get();
    if (!sub) return;
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
        error: "the event is gone",
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
  }

  async function drain() {
    for (;;) {
      const now = settings.now();
      expire(now);
      const heads = dueHeads(now);
      if (heads.length === 0) return;
      await Promise.all(
        heads.map((d) =>
          attempt(d).catch((error) =>
            console.error("webhook delivery crashed", d.id, error),
          ),
        ),
      );
      if (abort.signal.aborted) return;
    }
  }

  /** Runs a pass now, or right after the one in progress; resolves when that pass is done. */
  function tick(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again && !abort.signal.aborted);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    tick,
    /** Starts listening to the bus and polling; the first pass sends whatever an earlier run left. */
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = bus.subscribe((_: ActivityEvent) => void tick());
      timer = setInterval(() => void tick(), pollMs);
      timer.unref();
      void tick();
    },
    /** Stops sending, cuts requests in flight (their deliveries stay pending) and waits for the pass to end. */
    async stop() {
      stopped = true;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      abort.abort();
      await running;
    },
  };
}

export type WebhookWorker = ReturnType<typeof createWebhookWorker>;
