import { inArray, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { NotFoundError } from "./errors.js";

/**
 * The ids of the projects a caller sees: a person's by their invite (/api/web),
 * a bot key's by its project list; null is every project.
 */
export type VisibleIds = readonly string[] | null;

/**
 * `column` holds the id of a visible project, checked inside the query so a
 * page is never trimmed afterwards; a NULL project id is never visible to a
 * list. No condition when every project is visible.
 */
export const amongVisible = (
  column: SQLiteColumn,
  ids: VisibleIds,
): SQL | undefined => (ids === null ? undefined : inArray(column, [...ids]));

// One message for a reference that is missing and one the caller can't see, so a 404 never tells them apart.
const notFound = (what: string, ref: string, help?: string) =>
  new NotFoundError(
    `no ${what} ${ref}${help === undefined ? "" : `: ${help}`}`,
  );
export const noProject = (ref: string, help?: string) =>
  notFound("project", ref, help);
export const noIssue = (ref: string, help?: string) =>
  notFound("issue", ref, help);
