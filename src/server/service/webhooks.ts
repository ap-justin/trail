import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/id.js";
import {
  activityEvent,
  product,
  projectProduct,
  webhookDelivery,
  webhookSubscription,
  webhookSubscriptionProduct,
} from "../db/schema.js";
import type { Resolve } from "../webhooks/address.js";
import { type SecretKey, sealSecret } from "../webhooks/secret.js";
import {
  defaultSendDeps,
  type SendDeps,
  type Transport,
} from "../webhooks/send.js";
import { ValidationError } from "./errors.js";
import type { Tx } from "./tx.js";

/** What the service needs to store secrets and to send a test call. */
export type WebhookSettings = SendDeps & {
  /** aborts when the server is shutting down: a test call in flight is cut off */
  signal?: AbortSignal;
  key: SecretKey;
  /** the origin links in a webhook point at; with none, a webhook carries no links */
  publicUrl: string | undefined;
};

export function webhookSettings(
  key: SecretKey,
  overrides: {
    resolve?: Resolve;
    transport?: Transport;
    now?: () => number;
    publicUrl?: string | undefined;
    signal?: AbortSignal;
  } = {},
): WebhookSettings {
  return {
    ...defaultSendDeps,
    ...overrides,
    publicUrl: overrides.publicUrl,
    key,
  };
}

/** A bot's own limits: enough for a few routines, few enough that a loop of creates stops. */
export const WEBHOOKS_PER_BOT_MAX = 20;
export const WEBHOOK_PRODUCTS_MAX = 50;
export const WEBHOOK_SECRET_MIN = 16;
export const WEBHOOK_SECRET_MAX = 256;

/** Test calls one webhook may send per window: enough to debug a routine, too few to use trail as a request cannon. */
export const PING_LIMIT = 5;
export const PING_WINDOW_MS = 60_000;

/** A sliding window of ping times per webhook, in memory: a restart forgets it, which only ever allows a few extra. */
export function createPingLimiter(now: () => number) {
  const sent = new Map<string, number[]>();
  return {
    /** Records a ping and returns null, or returns the seconds to wait when the webhook is at its limit. */
    take(webhookId: string): number | null {
      const t = now();
      const recent = (sent.get(webhookId) ?? []).filter(
        (at) => at > t - PING_WINDOW_MS,
      );
      const oldest = recent[0];
      if (oldest !== undefined && recent.length >= PING_LIMIT) {
        sent.set(webhookId, recent);
        return Math.ceil((oldest + PING_WINDOW_MS - t) / 1000);
      }
      sent.set(webhookId, [...recent, t]);
      // webhooks that stopped pinging leave nothing behind
      if (sent.size > 1000) {
        for (const [id, times] of sent) {
          if (times.every((at) => at <= t - PING_WINDOW_MS)) sent.delete(id);
        }
      }
      return null;
    },
  };
}

export type Webhook = {
  id: string;
  actorId: string;
  url: string;
  /** product keys, A to Z */
  products: string[];
  pausedAt: Date | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SubscriptionRow = typeof webhookSubscription.$inferSelect;

export function validSecret(secret: string): string {
  if (
    secret.length < WEBHOOK_SECRET_MIN ||
    secret.length > WEBHOOK_SECRET_MAX
  ) {
    // the message never repeats the value
    throw new ValidationError(
      `secret must be ${WEBHOOK_SECRET_MIN} to ${WEBHOOK_SECRET_MAX} characters: send the signing secret your OpenBot webhook routine gave you`,
    );
  }
  return secret;
}

/** The subscriptions' views, each with its product keys. */
export function webhooksOf(db: Db | Tx, rows: SubscriptionRow[]): Webhook[] {
  if (rows.length === 0) return [];
  const links = db
    .select({
      subscriptionId: webhookSubscriptionProduct.subscriptionId,
      key: product.key,
    })
    .from(webhookSubscriptionProduct)
    .innerJoin(product, eq(product.id, webhookSubscriptionProduct.productId))
    .where(
      inArray(
        webhookSubscriptionProduct.subscriptionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(product.key))
    .all();
  return rows.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    url: r.url,
    products: links.filter((l) => l.subscriptionId === r.id).map((l) => l.key),
    pausedAt: r.pausedAt,
    consecutiveFailures: r.consecutiveFailures,
    lastSuccessAt: r.lastSuccessAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export function insertSubscription(
  tx: Tx,
  settings: WebhookSettings,
  input: { actorId: string; url: string; secret: string; productIds: string[] },
): SubscriptionRow {
  const id = newId();
  const row = tx
    .insert(webhookSubscription)
    .values({
      id,
      actorId: input.actorId,
      url: input.url,
      secretCipher: sealSecret(settings.key, id, input.secret),
    })
    .returning()
    .get();
  setProducts(tx, id, input.productIds);
  return row;
}

/**
 * 'pending' as SQL text, not a bound parameter: the planner matches the partial
 * index on pending deliveries only when it sees the literal.
 */
export const isPending = sql`${webhookDelivery.status} = 'pending'`;

/**
 * The subscription's pending deliveries whose event is in none of
 * `productIds`: an event of another product, or a project's own event (which
 * carries no product) when the project draws from none of them.
 */
export const unfollowedDeliveries = (
  tx: Tx | Db,
  subscriptionId: string,
  productIds: string[],
) =>
  tx
    .select({ id: webhookDelivery.id })
    .from(webhookDelivery)
    .innerJoin(activityEvent, eq(activityEvent.id, webhookDelivery.eventId))
    .where(
      and(
        eq(webhookDelivery.subscriptionId, subscriptionId),
        isPending,
        or(
          notInArray(activityEvent.productId, productIds),
          and(
            isNull(activityEvent.productId),
            notInArray(
              activityEvent.projectId,
              tx
                .select({ id: projectProduct.projectId })
                .from(projectProduct)
                .where(inArray(projectProduct.productId, productIds)),
            ),
          ),
        ),
      ),
    );

/**
 * Replaces the products a subscription follows. Its pending deliveries for a
 * product it no longer follows go with them, since the worker never re-checks
 * following, and so do those of a project's own events (which carry no
 * product) when the project draws from no product it still follows; sent and
 * failed ones stay as history. A product followed again
 * later gets only the events committed after.
 */
export function setProducts(
  tx: Tx,
  subscriptionId: string,
  productIds: string[],
) {
  tx.delete(webhookSubscriptionProduct)
    .where(eq(webhookSubscriptionProduct.subscriptionId, subscriptionId))
    .run();
  tx.insert(webhookSubscriptionProduct)
    .values(productIds.map((productId) => ({ subscriptionId, productId })))
    .run();
  tx.delete(webhookDelivery)
    .where(
      inArray(
        webhookDelivery.id,
        unfollowedDeliveries(tx, subscriptionId, productIds),
      ),
    )
    .run();
}

/**
 * Clears a pause and lets the deliveries that waited go out at once. The time
 * paused doesn't count toward their retry window: the worker measures it from
 * `created_at`, so that moves forward by the part of the pause each delivery
 * waited through.
 */
export function resume(tx: Tx, subscriptionId: string, now: number) {
  const pausedAt = tx
    .select({ at: webhookSubscription.pausedAt })
    .from(webhookSubscription)
    .where(eq(webhookSubscription.id, subscriptionId))
    .get()?.at;
  tx.update(webhookSubscription)
    .set({ pausedAt: null, consecutiveFailures: 0 })
    .where(eq(webhookSubscription.id, subscriptionId))
    .run();
  // an unpaused subscription's deliveries keep their backoff
  if (!pausedAt) return;
  // two-argument max() is SQLite's scalar max, not the aggregate
  const waitedThrough = sql`max(0, ${now} - max(${webhookDelivery.createdAt}, ${pausedAt.getTime()}))`;
  tx.update(webhookDelivery)
    .set({
      nextAttemptAt: new Date(now),
      createdAt: sql`${webhookDelivery.createdAt} + ${waitedThrough}`,
    })
    .where(and(eq(webhookDelivery.subscriptionId, subscriptionId), isPending))
    .run();
}

/**
 * Queues the committed event for every subscription following its product, or
 * for a project's own event (which has no product) every subscription following
 * any of the project's products now, inside the transaction that wrote it: the
 * outbox row exists exactly when the event does. A paused subscription is
 * queued too; its deliveries wait.
 */
export function enqueueDeliveries(
  tx: Tx,
  event: typeof activityEvent.$inferSelect,
  now: number,
) {
  const followed =
    event.productId !== null
      ? eq(webhookSubscriptionProduct.productId, event.productId)
      : event.projectId !== null
        ? inArray(
            webhookSubscriptionProduct.productId,
            tx
              .select({ id: projectProduct.productId })
              .from(projectProduct)
              .where(eq(projectProduct.projectId, event.projectId)),
          )
        : undefined;
  if (followed === undefined) return;
  const followers = tx
    .selectDistinct({ id: webhookSubscriptionProduct.subscriptionId })
    .from(webhookSubscriptionProduct)
    .where(followed)
    .all();
  if (followers.length === 0) return;
  const types = deliveryTypesOf(event.action);
  // in this order: the worker sends one event's deliveries in insertion order
  tx.insert(webhookDelivery)
    .values(
      followers.flatMap((f) =>
        types.map((type) => ({
          subscriptionId: f.id,
          eventId: event.id,
          seq: event.seq,
          type,
          nextAttemptAt: new Date(now),
        })),
      ),
    )
    .run();
}

/**
 * The webhook types an event goes out as: trail.<action>, and for a product
 * event also the trail.project.* it was sent as before products and projects
 * split, kept for one release.
 */
export function deliveryTypesOf(action: string): string[] {
  const type = `trail.${action}`;
  return action.startsWith("product.")
    ? [type, `trail.project.${action.slice("product.".length)}`]
    : [type];
}

export const countOwn = (db: Db | Tx, actorId: string): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(webhookSubscription)
    .where(eq(webhookSubscription.actorId, actorId))
    .get()?.n ?? 0;
