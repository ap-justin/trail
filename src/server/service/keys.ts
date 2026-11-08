import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actor, apiKey } from "../db/schema.js";
import { NotFoundError, ValidationError } from "./errors.js";

export type Actor = typeof actor.$inferSelect;

// trail_<8 hex prefix>_<43 base64url chars of 32 random bytes>; hex keeps `_` out of the prefix
const keyPattern = /^trail_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/;

const sha256 = (key: string) => createHash("sha256").update(key).digest();

function displayNameOf(displayName: string): string {
  const name = displayName.trim();
  if (name === "") throw new ValidationError("display name must not be empty");
  return name;
}

/** Creates a bot and its key. The key is returned once and never stored. */
export function createBot(
  db: Db,
  displayName: string,
): { actor: Actor; key: string } {
  const name = displayNameOf(displayName);
  const prefix = randomBytes(4).toString("hex");
  const key = `trail_${prefix}_${randomBytes(32).toString("base64url")}`;
  const bot = db.transaction(
    (tx) => {
      const created = tx
        .insert(actor)
        .values({ kind: "bot", displayName: name })
        .returning()
        .get();
      tx.insert(apiKey)
        .values({
          actorId: created.id,
          prefix,
          hash: sha256(key).toString("hex"),
        })
        .run();
      return created;
    },
    { behavior: "immediate" },
  );
  return { actor: bot, key };
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
