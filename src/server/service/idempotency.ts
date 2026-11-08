import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKey } from "../db/schema.js";
import { IdempotencyKeyReusedError, ValidationError } from "./errors.js";
import type { Tx } from "./tx.js";

/** What a create stores under an idempotency key, and what a repeat must match. */
export type IdempotentRequest = {
  key: string;
  // the create operation, e.g. "issue.create"
  scope: string;
  // the normalised input, with every reference resolved to an id
  request: unknown;
};

const maxKeyLength = 255;

export function validIdempotencyKey(key: string): string {
  if (key.length === 0 || key.length > maxKeyLength) {
    throw new ValidationError(
      `idempotency key must be 1 to ${maxKeyLength} characters`,
    );
  }
  return key;
}

// object keys sorted, so a field order the client happens to send doesn't change the hash
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const hashOf = (scope: string, request: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([scope, canonical(request)]))
    .digest("hex");

// the service's rows carry these as Date; the stored JSON holds them as ISO strings
const dateFields = new Set(["createdAt", "updatedAt", "completedAt"]);
const revive = (key: string, value: unknown) =>
  dateFields.has(key) && typeof value === "string" ? new Date(value) : value;

/**
 * The result first stored under this actor's key, or undefined when the key is
 * new. A key stored for another scope or request throws.
 */
export function replayOf<T>(
  tx: Tx,
  actorId: string,
  idem: IdempotentRequest,
): T | undefined {
  const stored = tx
    .select()
    .from(idempotencyKey)
    .where(
      and(
        eq(idempotencyKey.actorId, actorId),
        eq(idempotencyKey.key, idem.key),
      ),
    )
    .get();
  if (!stored) return undefined;
  if (
    stored.scope !== idem.scope ||
    stored.requestHash !== hashOf(idem.scope, idem.request)
  ) {
    throw new IdempotencyKeyReusedError(
      `idempotency key "${idem.key}" was already used for a different ${stored.scope === idem.scope ? "request body or target" : `operation (${stored.scope})`}: send a new key for a new create, or resend the first request unchanged to get its result`,
    );
  }
  return JSON.parse(JSON.stringify(stored.response), revive) as T;
}

/** Stores `result` as the response to replay for this key; call in the write's transaction. */
export function storeResult(
  tx: Tx,
  actorId: string,
  idem: IdempotentRequest,
  result: unknown,
): void {
  tx.insert(idempotencyKey)
    .values({
      actorId,
      key: idem.key,
      scope: idem.scope,
      requestHash: hashOf(idem.scope, idem.request),
      response: JSON.parse(JSON.stringify(result)),
    })
    .run();
}
