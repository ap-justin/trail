import { inArray, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { NotFoundError } from "./errors.js";

/**
 * The ids of the products a caller sees: a person's by their invite (/api/web),
 * a bot key's by its product list; null is every product.
 */
export type VisibleIds = readonly string[] | null;

/**
 * `column` holds the id of a visible product, checked inside the query so a
 * page is never trimmed afterwards; a NULL product id is never visible to a
 * list. No condition when every product is visible.
 */
export const amongVisible = (
  column: SQLiteColumn,
  ids: VisibleIds,
): SQL | undefined => (ids === null ? undefined : inArray(column, [...ids]));

// One message for a reference that is missing and one the caller can't see, so a 404 never tells them apart.
const notFound = (what: string, ref: string, help: string) =>
  new NotFoundError(`no ${what} ${ref}: ${help}`);
export const noProduct = (ref: string) =>
  notFound(
    "product",
    ref,
    "pass the key (like TRL) of a product this key reaches; list_products (GET /api/v1/products) lists them",
  );
export const noProject = (ref: string) =>
  notFound(
    "project",
    ref,
    "pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them",
  );
export const noIssue = (ref: string) =>
  notFound(
    "item",
    ref,
    "pass the key (like TRL-12), the id or the source key (like JUS-187, kept from an import) of an item this key reaches; list_items (GET /api/v1/items) finds them",
  );
