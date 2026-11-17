import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client.js";
import { newId } from "../db/id.js";
import {
  activityEvent,
  apiKey,
  comment,
  product,
  project,
  projectItem,
  projectProduct,
  type WebhookSubscriptionKind,
  webhookDelivery,
  webhookSubscription,
  webhookSubscriptionProduct,
  webhookSubscriptionProject,
} from "../db/schema.js";
import type { Resolve } from "../webhooks/address.js";
import { type SecretKey, sealSecret } from "../webhooks/secret.js";
import {
  defaultSendDeps,
  type SendDeps,
  type Transport,
} from "../webhooks/send.js";
import { ValidationError } from "./errors.js";
import { liveKeyScope } from "./keys.js";
import type { Tx } from "./tx.js";
import { eventsReached, projectsReached, reachOfScope } from "./visible.js";

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
  kind: WebhookSubscriptionKind;
  actorId: string;
  url: string;
  /** product keys, A to Z */
  products: string[];
  /** project slugs, A to Z */
  projects: string[];
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

/** The subscriptions' views, each with its product keys and project slugs. */
export function webhooksOf(db: Db | Tx, rows: SubscriptionRow[]): Webhook[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const groups = db
    .select({
      subscriptionId: webhookSubscriptionProject.subscriptionId,
      slug: project.slug,
    })
    .from(webhookSubscriptionProject)
    .innerJoin(project, eq(project.id, webhookSubscriptionProject.projectId))
    .where(inArray(webhookSubscriptionProject.subscriptionId, ids))
    .orderBy(asc(project.slug))
    .all();
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
    kind: r.kind,
    actorId: r.actorId,
    url: r.url,
    products: links.filter((l) => l.subscriptionId === r.id).map((l) => l.key),
    projects: groups
      .filter((g) => g.subscriptionId === r.id)
      .map((g) => g.slug),
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
  input: {
    kind: WebhookSubscriptionKind;
    actorId: string;
    apiKeyId: string | null;
    url: string;
    secret: string;
    productIds: string[];
    projectIds: string[];
  },
): SubscriptionRow {
  const id = newId();
  const row = tx
    .insert(webhookSubscription)
    .values({
      id,
      kind: input.kind,
      actorId: input.actorId,
      apiKeyId: input.apiKeyId,
      url: input.url,
      secretCipher: sealSecret(settings.key, id, input.secret),
    })
    .returning()
    .get();
  // an inbox subscription follows none
  if (input.productIds.length > 0 || input.projectIds.length > 0) {
    setFollows(tx, id, {
      productIds: input.productIds,
      projectIds: input.projectIds,
    });
  }
  return row;
}

/**
 * 'pending' as SQL text, not a bound parameter: the planner matches the partial
 * index on pending deliveries only when it sees the literal.
 */
export const isPending = sql`${webhookDelivery.status} = 'pending'`;

/**
 * The event is one a follower of the project in `projectId` gets: the
 * project's own event or an item joining or leaving it, or an event of an item
 * in it now or of a comment on one. Membership is read as it is when the query
 * runs, so an item that left stops at once; its joining another project stays
 * with that project's followers.
 */
const eventOfProject = (tx: Tx | Db, projectId: SQLiteColumn) =>
  or(
    eq(activityEvent.projectId, projectId),
    and(
      isNull(activityEvent.projectId),
      or(
        and(
          eq(activityEvent.subjectType, "issue"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(projectItem)
              .where(
                and(
                  eq(projectItem.projectId, projectId),
                  eq(projectItem.issueId, activityEvent.subjectId),
                ),
              ),
          ),
        ),
        and(
          eq(activityEvent.subjectType, "comment"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(comment)
              .innerJoin(projectItem, eq(projectItem.issueId, comment.issueId))
              .where(
                and(
                  eq(comment.id, activityEvent.subjectId),
                  eq(projectItem.projectId, projectId),
                ),
              ),
          ),
        ),
      ),
    ),
  ) as SQL;

/** The subscription follows a project the event in `activityEvent` belongs to now. */
const followedByProject = (tx: Tx | Db, subscriptionId: string) =>
  exists(
    tx
      .select({ one: sql`1` })
      .from(webhookSubscriptionProject)
      .where(
        and(
          eq(webhookSubscriptionProject.subscriptionId, subscriptionId),
          eventOfProject(tx, webhookSubscriptionProject.projectId),
        ),
      ),
  );

/**
 * The subscription's pending deliveries whose event is in none of
 * `productIds` (an event of another product, or a project's own event, which
 * carries no product, when the project draws from none of them) and in none
 * of the projects it follows.
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
        not(followedByProject(tx, subscriptionId)),
      ),
    );

/**
 * Replaces the products or the projects a subscription follows, each list
 * left out staying as it is. Its pending deliveries that neither list covers
 * now go with them, and sent and failed ones stay as history: a product's
 * event when it no longer follows the product, a project's own event (which
 * carries no product) when it follows neither the project nor a product the
 * project draws from, an item's when it follows neither its product nor a
 * project it is in. Something followed again later gets only the events
 * committed after.
 */
export function setFollows(
  tx: Tx,
  subscriptionId: string,
  follows: { productIds?: string[]; projectIds?: string[] },
) {
  const { productIds, projectIds } = follows;
  if (productIds !== undefined) {
    tx.delete(webhookSubscriptionProduct)
      .where(eq(webhookSubscriptionProduct.subscriptionId, subscriptionId))
      .run();
    if (productIds.length > 0) {
      tx.insert(webhookSubscriptionProduct)
        .values(productIds.map((productId) => ({ subscriptionId, productId })))
        .run();
    }
  }
  if (projectIds !== undefined) {
    tx.delete(webhookSubscriptionProject)
      .where(eq(webhookSubscriptionProject.subscriptionId, subscriptionId))
      .run();
    if (projectIds.length > 0) {
      tx.insert(webhookSubscriptionProject)
        .values(projectIds.map((projectId) => ({ subscriptionId, projectId })))
        .run();
    }
  }
  const followed =
    productIds ??
    tx
      .select({ id: webhookSubscriptionProduct.productId })
      .from(webhookSubscriptionProduct)
      .where(eq(webhookSubscriptionProduct.subscriptionId, subscriptionId))
      .all()
      .map((r) => r.id);
  tx.delete(webhookDelivery)
    .where(
      inArray(
        webhookDelivery.id,
        unfollowedDeliveries(tx, subscriptionId, followed),
      ),
    )
    .run();
}

const KEY_REVOKED = "not sent: this webhook's key is revoked";
const keyLost = (what: string) =>
  `not sent: this webhook's key no longer reaches ${what}`;

/**
 * Why `keyId` may not send the subscription `event` now, as the delivery's
 * lastError; null when it may. Read as the key stands: revoked, or its scope
 * no longer reaching a product or project the subscription follows, or the
 * event (by the reach rules every read uses). An unrestricted key only fails
 * revoked. Bots alone hold keys, so the reach is a bot's.
 */
function keyRefusal(
  db: Db,
  keyId: string,
  subscriptionId: string,
  event: typeof activityEvent.$inferSelect,
): string | null {
  const scope = liveKeyScope(db, keyId);
  if (!scope) return KEY_REVOKED;
  const reach = reachOfScope(scope, true);
  if (reach === null) return null;
  const lostProduct = db
    .select({ key: product.key })
    .from(webhookSubscriptionProduct)
    .innerJoin(product, eq(product.id, webhookSubscriptionProduct.productId))
    .where(
      and(
        eq(webhookSubscriptionProduct.subscriptionId, subscriptionId),
        notInArray(webhookSubscriptionProduct.productId, [...reach.products]),
      ),
    )
    .get();
  if (lostProduct) return keyLost(lostProduct.key);
  const lostProject = db
    .select({ slug: project.slug })
    .from(webhookSubscriptionProject)
    .innerJoin(project, eq(project.id, webhookSubscriptionProject.projectId))
    .where(
      and(
        eq(webhookSubscriptionProject.subscriptionId, subscriptionId),
        not(projectsReached(db, reach, project.id) as SQL),
      ),
    )
    .get();
  if (lostProject) return keyLost(lostProject.slug);
  const reached = db
    .select({ one: sql`1` })
    .from(activityEvent)
    .where(and(eq(activityEvent.id, event.id), eventsReached(db, reach)))
    .get();
  if (reached) return null;
  return keyLost(eventScopeName(db, event));
}

/**
 * Why `sub` may not be sent this delivery now, as its lastError; null when it
 * may. An activity delivery carries its `event` and is held to `keyRefusal`;
 * an inbox delivery has none and needs only its key live. A webhook with no
 * recorded key, made before keys were recorded and unchanged since, stands on
 * its bot's live keys: an activity delivery goes when any one of them may send
 * it, and is refused with the oldest's reason when none may.
 */
export function deliveryKeyRefusal(
  db: Db,
  sub: typeof webhookSubscription.$inferSelect,
  event: typeof activityEvent.$inferSelect | null,
): string | null {
  if (sub.apiKeyId !== null) {
    if (event !== null) return keyRefusal(db, sub.apiKeyId, sub.id, event);
    return isLive(db, sub.apiKeyId) ? null : KEY_REVOKED;
  }
  const keys = liveKeysOf(db, sub.actorId);
  if (keys.length === 0) return NO_LIVE_KEY;
  if (event === null) return null;
  let first: string | null = null;
  for (const keyId of keys) {
    const refusal = keyRefusal(db, keyId, sub.id, event);
    if (refusal === null) return null;
    first ??= refusal;
  }
  return first;
}

const NO_LIVE_KEY = "not sent: this bot has no live key";

const isLive = (db: Db, keyId: string) =>
  db
    .select({ one: sql`1` })
    .from(apiKey)
    .where(and(eq(apiKey.id, keyId), isNull(apiKey.revokedAt)))
    .get() !== undefined;

/** The bot's unrevoked keys, oldest first. */
const liveKeysOf = (db: Db, botId: string) =>
  db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(and(eq(apiKey.actorId, botId), isNull(apiKey.revokedAt)))
    .orderBy(apiKey.createdAt, apiKey.id)
    .all()
    .map((k) => k.id);

/** The key of the event's product, else the slug of its project. */
function eventScopeName(
  db: Db,
  event: typeof activityEvent.$inferSelect,
): string {
  const row = db
    .select({
      name: sql<string | null>`coalesce(${product.key}, ${project.slug})`,
    })
    .from(activityEvent)
    .leftJoin(product, eq(product.id, activityEvent.productId))
    .leftJoin(project, eq(project.id, activityEvent.projectId))
    .where(eq(activityEvent.id, event.id))
    .get();
  return row?.name ?? "this event";
}

/**
 * True for an item's or a comment's event the subscription follows no more:
 * it follows neither the item's product nor a project the item is in now.
 * Replacing the follows deletes what they no longer cover, so this is an item
 * that left a followed project after its event was queued. A project's own
 * event, an item's joining or leaving one among them, never is.
 */
export function leftFollowedProjects(
  db: Db,
  subscriptionId: string,
  event: typeof activityEvent.$inferSelect,
): boolean {
  if (event.projectId !== null) return false;
  if (event.subjectType !== "issue" && event.subjectType !== "comment") {
    return false;
  }
  const stillFollowed = db
    .select({ one: sql`1` })
    .from(activityEvent)
    .where(
      and(
        eq(activityEvent.id, event.id),
        or(
          exists(
            db
              .select({ one: sql`1` })
              .from(webhookSubscriptionProduct)
              .where(
                and(
                  eq(webhookSubscriptionProduct.subscriptionId, subscriptionId),
                  eq(
                    webhookSubscriptionProduct.productId,
                    activityEvent.productId,
                  ),
                ),
              ),
          ),
          followedByProject(db, subscriptionId),
        ),
      ),
    )
    .get();
  return stillFollowed === undefined;
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
 * Queues the committed event, inside the transaction that wrote it, for every
 * subscription following its product (for a project's own event, which has no
 * product, any of the project's products now) and every subscription
 * following a project the event belongs to now: the outbox row exists exactly
 * when the event does. A subscription matching both ways is queued once. A
 * paused subscription is queued too; its deliveries wait.
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
  const byProduct =
    followed === undefined
      ? []
      : tx
          .selectDistinct({ id: webhookSubscriptionProduct.subscriptionId })
          .from(webhookSubscriptionProduct)
          .where(followed)
          .all();
  const byProject = tx
    .selectDistinct({ id: webhookSubscriptionProject.subscriptionId })
    .from(webhookSubscriptionProject)
    .innerJoin(activityEvent, eq(activityEvent.id, event.id))
    .where(eventOfProject(tx, webhookSubscriptionProject.projectId))
    .all();
  const followers = [...new Set([...byProduct, ...byProject].map((f) => f.id))];
  if (followers.length === 0) return;
  const types = deliveryTypesOf(event.action);
  // in this order: the worker sends one event's deliveries in insertion order
  tx.insert(webhookDelivery)
    .values(
      followers.flatMap((subscriptionId) =>
        types.map((type) => ({
          subscriptionId,
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
 * The webhook types an event goes out as: trail.<action>, and for one release
 * a second type beside it: a product event also as the trail.project.* it was
 * sent as before products and projects split, an item event also as the
 * trail.item.* that replaces trail.issue.*.
 */
export function deliveryTypesOf(action: string): string[] {
  const type = `trail.${action}`;
  const [subject, verb] = action.split(".", 2);
  if (subject === "product") return [type, `trail.project.${verb}`];
  if (subject === "issue") return [type, `trail.item.${verb}`];
  return [type];
}

export const countOwn = (db: Db | Tx, actorId: string): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(webhookSubscription)
    .where(eq(webhookSubscription.actorId, actorId))
    .get()?.n ?? 0;
