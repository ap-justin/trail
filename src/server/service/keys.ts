import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actor, apiKey } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { Tx } from "./tx.js";

export type Actor = typeof actor.$inferSelect;

// trail_<8 hex prefix>_<43 base64url chars of 32 random bytes>; hex keeps `_` out of the prefix
const keyPattern = /^trail_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/;

const sha256 = (key: string) => createHash("sha256").update(key).digest();

function labelOf(raw: string): string {
  const label = raw.trim();
  if (label === "") throw new ValidationError("label must not be empty");
  return label;
}

function displayNameOf(displayName: string): string {
  const name = displayName.trim();
  if (name === "") throw new ValidationError("display name must not be empty");
  return name;
}

function mintKey(tx: Tx, actorId: string): string {
  const prefix = randomBytes(4).toString("hex");
  const key = `trail_${prefix}_${randomBytes(32).toString("base64url")}`;
  tx.insert(apiKey)
    .values({ actorId, prefix, hash: sha256(key).toString("hex") })
    .run();
  return key;
}

/**
 * Creates a bot and its key. The key is returned once and never stored. A bot's
 * name, and its label when it has one, are unique among bots.
 */
export function createBot(
  db: Db,
  displayName: string,
  options: { label?: string } = {},
): { actor: Actor; key: string } {
  const name = displayNameOf(displayName);
  const label = options.label === undefined ? null : labelOf(options.label);
  return db.transaction(
    (tx) => {
      const twin = tx
        .select()
        .from(actor)
        .where(and(eq(actor.kind, "bot"), eq(actor.displayName, name)))
        .get();
      if (twin) {
        throw new ConflictError(
          `a bot named "${name}" already exists (${twin.id}): pick another name, or mint it another key with \`trail key create ${twin.label ?? twin.id}\``,
        );
      }
      if (label !== null) {
        const holder = tx
          .select()
          .from(actor)
          .where(and(eq(actor.kind, "bot"), eq(actor.label, label)))
          .get();
        if (holder) {
          throw new ConflictError(
            `label "${label}" is already on bot "${holder.displayName}" (${holder.id}): one label names one bot, so mint that bot another key with \`trail key create ${label}\``,
          );
        }
      }
      const created = tx
        .insert(actor)
        .values({ kind: "bot", displayName: name, label })
        .returning()
        .get();
      return { actor: created, key: mintKey(tx, created.id) };
    },
    { behavior: "immediate" },
  );
}

/** Mints another key for the bot with this actor id or label. */
export function createKey(
  db: Db,
  botRef: string,
): { actor: Actor; key: string } {
  return db.transaction(
    (tx) => {
      const bot = tx
        .select()
        .from(actor)
        .where(
          and(
            eq(actor.kind, "bot"),
            or(eq(actor.id, botRef), eq(actor.label, botRef)),
          ),
        )
        .get();
      if (!bot) {
        throw new NotFoundError(
          `no bot with id or label ${botRef}: \`trail key list\` shows each bot's id and label`,
        );
      }
      return { actor: bot, key: mintKey(tx, bot.id) };
    },
    { behavior: "immediate" },
  );
}

export type KeyListing = {
  prefix: string;
  actorId: string;
  displayName: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

/** Every key, oldest first, without its hash. */
export function listKeys(db: Db): KeyListing[] {
  return db
    .select({
      prefix: apiKey.prefix,
      actorId: apiKey.actorId,
      displayName: actor.displayName,
      label: actor.label,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    })
    .from(apiKey)
    .innerJoin(actor, eq(actor.id, apiKey.actorId))
    .orderBy(asc(apiKey.createdAt), asc(apiKey.id))
    .all();
}

export function createHuman(
  db: Db,
  input: { displayName: string; githubId?: number },
): Actor {
  return db
    .insert(actor)
    .values({
      kind: "human",
      displayName: displayNameOf(input.displayName),
      githubId: input.githubId,
    })
    .returning()
    .get();
}

/** Revokes the key with this prefix; revoking a revoked key keeps its first `revokedAt`. */
export function revokeKey(
  db: Db,
  prefix: string,
): { prefix: string; actorId: string; revokedAt: Date } {
  return db.transaction(
    (tx) => {
      const key = tx
        .select()
        .from(apiKey)
        .where(eq(apiKey.prefix, prefix))
        .get();
      if (!key) throw new NotFoundError(`no key with prefix ${prefix}`);
      const revokedAt = key.revokedAt ?? new Date();
      if (!key.revokedAt) {
        tx.update(apiKey).set({ revokedAt }).where(eq(apiKey.id, key.id)).run();
      }
      return { prefix, actorId: key.actorId, revokedAt };
    },
    { behavior: "immediate" },
  );
}

/** The bot a bearer token belongs to, or null when it is malformed, unknown or revoked. */
export function resolveKey(db: Db, token: string): Actor | null {
  const prefix = keyPattern.exec(token)?.[1];
  if (prefix === undefined) return null;
  const row = db
    .select({ actor, hash: apiKey.hash, revokedAt: apiKey.revokedAt })
    .from(apiKey)
    .innerJoin(actor, eq(actor.id, apiKey.actorId))
    .where(eq(apiKey.prefix, prefix))
    .get();
  if (!row || row.revokedAt) return null;
  return timingSafeEqual(sha256(token), Buffer.from(row.hash, "hex"))
    ? row.actor
    : null;
}
