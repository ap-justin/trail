import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  comment,
  project,
  projectItem,
  projectProduct,
} from "../db/schema.js";
import { NotFoundError } from "./errors.js";

/**
 * What a caller reaches, by id; null is everything. A person reaches their
 * invited products (/api/web) and no project of their own; a bot key its
 * products and projects. Project membership is read in each query, never
 * copied onto the key.
 */
export type Reach = {
  products: readonly string[];
  projects: readonly string[];
} | null;

/**
 * `column` holds the id of one of these products, checked inside the query so
 * a page is never trimmed afterwards; a NULL product id is never among them.
 * No condition for null, every product.
 */
export const amongProducts = (
  column: SQLiteColumn,
  ids: readonly string[] | null,
): SQL | undefined => (ids === null ? undefined : inArray(column, [...ids]));

/** The ids of the items in the reach's projects, as a subquery. */
const itemsOfProjects = (db: Db, projects: readonly string[]) =>
  db
    .select({ id: projectItem.issueId })
    .from(projectItem)
    .where(inArray(projectItem.projectId, [...projects]));

/**
 * The item in `issueId` (of product `productId`) is reached: its product is
 * one of the reach's, or it is in one of the reach's projects now.
 */
export function itemsReached(
  db: Db,
  reach: Reach,
  issueId: SQLiteColumn,
  productId: SQLiteColumn,
): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(productId, [...reach.products]);
  if (reach.projects.length === 0) return byProduct;
  return or(byProduct, inArray(issueId, itemsOfProjects(db, reach.projects)));
}

/**
 * The product in `column` is one the caller may name, to read its name, key
 * and labels or to file into: one of the reach's products, or one a reached
 * project draws from. Naming a product reaches none of its items.
 */
export function productsNamed(
  db: Db,
  reach: Reach,
  column: SQLiteColumn,
): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(column, [...reach.products]);
  if (reach.projects.length === 0) return byProduct;
  return or(
    byProduct,
    inArray(
      column,
      db
        .select({ id: projectProduct.productId })
        .from(projectProduct)
        .where(inArray(projectProduct.projectId, [...reach.projects])),
    ),
  );
}

/** The project in `column` is reached: one of the reach's, or one drawing from one of its products. */
export function projectsReached(
  db: Db,
  reach: Reach,
  column: SQLiteColumn = project.id,
): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(
    column,
    db
      .select({ id: projectProduct.projectId })
      .from(projectProduct)
      .where(inArray(projectProduct.productId, [...reach.products])),
  );
  if (reach.projects.length === 0) return byProduct;
  return or(byProduct, inArray(column, [...reach.projects]));
}

/**
 * The events `reach` sees: every event of its products; a project's own
 * events (no product) when it reaches the project; and, through its projects,
 * every item joining or leaving one of them, the removal being the last event
 * of an item that left, as a webhook following the project gets it, and the
 * events of the items in them now and of their comments, an item's
 * membership event only when that event's project is reached too.
 */
export function eventsReached(db: Db, reach: Reach): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(activityEvent.productId, [...reach.products]);
  const projectOwn = and(
    isNull(activityEvent.productId),
    projectsReached(db, reach, activityEvent.projectId),
  );
  if (reach.projects.length === 0) return or(byProduct, projectOwn);
  const items = itemsOfProjects(db, reach.projects);
  return or(
    byProduct,
    projectOwn,
    and(
      eq(activityEvent.subjectType, "issue"),
      inArray(activityEvent.projectId, [...reach.projects]),
    ),
    and(
      eq(activityEvent.subjectType, "issue"),
      inArray(activityEvent.subjectId, items),
      or(
        isNull(activityEvent.projectId),
        projectsReached(db, reach, activityEvent.projectId),
      ),
    ),
    and(
      eq(activityEvent.subjectType, "comment"),
      inArray(
        activityEvent.subjectId,
        db
          .select({ id: comment.id })
          .from(comment)
          .where(inArray(comment.issueId, items)),
      ),
    ),
  );
}

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
    "pass the key (like TRL-12), the id or the source key (the key it had in the system it was imported from, like ABC-187) of an item this key reaches; list_items (GET /api/v1/items) finds them",
  );
