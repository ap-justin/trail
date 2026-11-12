import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/id.js";
import {
  type activityEvent,
  project,
  webhookDelivery,
  webhookSubscription,
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
import type { Tx } from "./tx.js";

/** What the service needs to store secrets and to send a test call. */
export type WebhookSettings = SendDeps & {
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
export const WEBHOOK_PROJECTS_MAX = 50;
export const WEBHOOK_SECRET_MIN = 16;
export const WEBHOOK_SECRET_MAX = 256;

export type Webhook = {
  id: string;
  actorId: string;
  url: string;
  /** project keys, A to Z */
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

/** The subscriptions' views, each with its project keys. */
export function webhooksOf(db: Db | Tx, rows: SubscriptionRow[]): Webhook[] {
  if (rows.length === 0) return [];
  const links = db
    .select({
      subscriptionId: webhookSubscriptionProject.subscriptionId,
      key: project.key,
    })
    .from(webhookSubscriptionProject)
    .innerJoin(project, eq(project.id, webhookSubscriptionProject.projectId))
    .where(
      inArray(
        webhookSubscriptionProject.subscriptionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(project.key))
    .all();
  return rows.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    url: r.url,
    projects: links.filter((l) => l.subscriptionId === r.id).map((l) => l.key),
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
  input: { actorId: string; url: string; secret: string; projectIds: string[] },
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
  setProjects(tx, id, input.projectIds);
  return row;
}

export function setProjects(
  tx: Tx,
  subscriptionId: string,
  projectIds: string[],
) {
  tx.delete(webhookSubscriptionProject)
    .where(eq(webhookSubscriptionProject.subscriptionId, subscriptionId))
    .run();
  tx.insert(webhookSubscriptionProject)
    .values(projectIds.map((projectId) => ({ subscriptionId, projectId })))
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
    .where(
      and(
        eq(webhookDelivery.subscriptionId, subscriptionId),
        eq(webhookDelivery.status, "pending"),
      ),
    )
    .run();
}

/**
 * Queues the committed event for every subscription following its project,
 * inside the transaction that wrote it: the outbox row exists exactly when the
 * event does. A paused subscription is queued too; its deliveries wait.
 */
export function enqueueDeliveries(
  tx: Tx,
  event: typeof activityEvent.$inferSelect,
  now: number,
) {
  if (event.projectId === null) return;
  const followers = tx
    .select({ id: webhookSubscriptionProject.subscriptionId })
    .from(webhookSubscriptionProject)
    .where(eq(webhookSubscriptionProject.projectId, event.projectId))
    .all();
  if (followers.length === 0) return;
  tx.insert(webhookDelivery)
    .values(
      followers.map((f) => ({
        subscriptionId: f.id,
        eventId: event.id,
        seq: event.seq,
        type: `trail.${event.action}`,
        nextAttemptAt: new Date(now),
      })),
    )
    .run();
}

export const countOwn = (db: Db | Tx, actorId: string): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(webhookSubscription)
    .where(eq(webhookSubscription.actorId, actorId))
    .get()?.n ?? 0;
