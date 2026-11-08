import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { ValidationError } from "./errors.js";

export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageQuery = { cursor?: string; limit?: number };

const defaultLimit = 50;
const maxLimit = 200;

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return encode([row.createdAt.getTime(), row.id]);
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = decode(cursor);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !Number.isSafeInteger(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    throw new ValidationError(
      "cursor is invalid: pass a nextCursor exactly as the previous page returned it, or leave cursor out for the first page",
    );
  }
  return { createdAt: new Date(parsed[0]), id: parsed[1] };
}

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new ValidationError(`limit must be an integer from 1 to ${maxLimit}`);
  }
  return limit;
}

type Keyset = { createdAt: SQLiteColumn; id: SQLiteColumn };

/**
 * One page ordered by (created_at, id) in `direction`, the cursor naming the
 * last row of the previous page. `run` gets the where clause, order and limit.
 */
export function page<T extends { createdAt: Date; id: string }>(
  keys: Keyset,
  direction: "asc" | "desc",
  query: PageQuery,
  filters: (SQL | undefined)[],
  run: (where: SQL | undefined, orderBy: SQL[], limit: number) => T[],
): Page<T> {
  const limit = pageLimit(query.limit);
  const past = direction === "desc" ? lt : gt;
  const order = direction === "desc" ? desc : asc;
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    filters.push(
      or(
        past(keys.createdAt, after.createdAt),
        and(eq(keys.createdAt, after.createdAt), past(keys.id, after.id)),
      ),
    );
  }
  const rows = run(
    and(...filters),
    [order(keys.createdAt), order(keys.id)],
    limit + 1,
  );
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/** The filters a feed cursor was issued under; null is "not filtered". */
export type FeedFilters = { projectId: string | null; actorId: string | null };
export type FeedPosition = FeedFilters & { seq: number };

export function encodeFeedCursor(position: FeedPosition): string {
  return encode({
    seq: position.seq,
    projectId: position.projectId,
    actorId: position.actorId,
  });
}

const describeFilters = (f: FeedFilters) =>
  `projectId=${f.projectId ?? "(none)"}, actorId=${f.actorId ?? "(none)"}`;

/** The seq a feed cursor points at, refused when it was issued under other filters. */
export function decodeFeedCursor(cursor: string, filters: FeedFilters): number {
  const parsed = decode(cursor) as Partial<FeedPosition> | undefined;
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Number.isSafeInteger(parsed.seq) ||
    (parsed.seq as number) < 0 ||
    !nullableString(parsed.projectId) ||
    !nullableString(parsed.actorId)
  ) {
    throw new ValidationError(
      "cursor is invalid: pass a nextCursor exactly as a previous activity page returned it",
    );
  }
  const issued = parsed as FeedPosition;
  if (
    issued.projectId !== filters.projectId ||
    issued.actorId !== filters.actorId
  ) {
    throw new ValidationError(
      `cursor was issued for ${describeFilters(issued)} but this request has ${describeFilters(filters)}: repeat the cursor's filters, or drop the cursor to start over`,
    );
  }
  return issued.seq;
}
