import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  comment,
  issue,
  product,
  project,
  projectItem,
  projectProduct,
} from "../db/schema.js";
import { NotFoundError } from "./errors.js";

/**
 * What a caller reaches, by id; null is everything. A person reaches their
 * invited products (/api/web) and no project of their own; a bot key its
 * products and projects, and with `implicitProjects` the items of every
 * project drawing from its products too, to read and comment on. Project
 * membership is read in each query, never copied onto the key.
 */
export type Reach = {
  products: readonly string[];
  projects: readonly string[];
  implicitProjects: boolean;
} | null;

/**
 * The reach of a key with these products and projects: everything when
 * `products` is null. A bot also reads the items of the projects drawing from
 * its products; a person keeps the per-product view.
 */
export const reachOfScope = (
  scope: {
    products: readonly { id: string }[] | null;
    projects: readonly { id: string }[];
  },
  bot: boolean,
): Reach =>
  scope.products === null
    ? null
    : {
        products: scope.products.map((p) => p.id),
        projects: scope.projects.map((p) => p.id),
        implicitProjects: bot,
      };

/**
 * `column` holds the id of one of these products, checked inside the query so
 * a page is never trimmed afterwards; a NULL product id is never among them.
 * No condition for null, every product.
 */
export const amongProducts = (
  column: SQLiteColumn,
  ids: readonly string[] | null,
): SQL | undefined => (ids === null ? undefined : inArray(column, [...ids]));

/** The ids of the projects drawing from one of these products, as a subquery. */
const projectsDrawingFrom = (db: Db, products: readonly string[]) =>
  db
    .select({ id: projectProduct.projectId })
    .from(projectProduct)
    .where(inArray(projectProduct.productId, [...products]));

/**
 * `column` holds the id of a project whose items the reach reaches: one it
 * lists, or with `implicitProjects` one drawing from its products. Null when
 * it reaches the items of no project.
 */
function itemProjects(
  db: Db,
  reach: NonNullable<Reach>,
  column: SQLiteColumn,
): SQL | null {
  const listed =
    reach.projects.length === 0
      ? undefined
      : inArray(column, [...reach.projects]);
  const drawing =
    reach.implicitProjects && reach.products.length > 0
      ? inArray(column, projectsDrawingFrom(db, reach.products))
      : undefined;
  return or(listed, drawing) ?? null;
}

/**
 * The item in `issueId` (of product `productId`) is reached: its product is
 * one of the reach's, or it is in one of the projects whose items it reaches
 * now.
 */
export function itemsReached(
  db: Db,
  reach: Reach,
  issueId: SQLiteColumn,
  productId: SQLiteColumn,
): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(productId, [...reach.products]);
  const projects = itemProjects(db, reach, projectItem.projectId);
  if (projects === null) return byProduct;
  return or(
    byProduct,
    inArray(
      issueId,
      db.select({ id: projectItem.issueId }).from(projectItem).where(projects),
    ),
  );
}

/**
 * The product in `column` is one the caller may name, to read its name and
 * key: one of the reach's products, or one a project whose items it reaches
 * draws from. Naming a product reaches none of its items, and reads its labels
 * and files on it only through a listed project.
 */
export function productsNamed(
  db: Db,
  reach: Reach,
  column: SQLiteColumn,
): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(column, [...reach.products]);
  const projects = itemProjects(db, reach, projectProduct.projectId);
  if (projects === null) return byProduct;
  return or(
    byProduct,
    inArray(
      column,
      db
        .select({ id: projectProduct.productId })
        .from(projectProduct)
        .where(projects),
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
  const byProduct = inArray(column, projectsDrawingFrom(db, reach.products));
  if (reach.projects.length === 0) return byProduct;
  return or(byProduct, inArray(column, [...reach.projects]));
}

/**
 * The events `reach` sees: every event of its products; a project's own
 * events (no product) when it reaches the project; and, through the projects
 * whose items it reaches, every item joining or leaving one of them, the
 * removal being the last event of an item that left, as a webhook following
 * the project gets it, and the events of the items in them now and of their
 * comments, an item's membership event only when that event's project is
 * reached too.
 */
export function eventsReached(db: Db, reach: Reach): SQL | undefined {
  if (reach === null) return undefined;
  const byProduct = inArray(activityEvent.productId, [...reach.products]);
  const projectOwn = and(
    isNull(activityEvent.productId),
    projectsReached(db, reach, activityEvent.projectId),
  );
  const projects = itemProjects(db, reach, projectItem.projectId);
  if (projects === null) return or(byProduct, projectOwn);
  const items = db
    .select({ id: projectItem.issueId })
    .from(projectItem)
    .where(projects);
  return or(
    byProduct,
    projectOwn,
    and(
      eq(activityEvent.subjectType, "issue"),
      itemProjects(db, reach, activityEvent.projectId) as SQL,
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

/** A note's about on its events: as it stands on a create, as it changed on an update. */
type About =
  | { about: string[]; aboutOthers: number }
  | {
      about: { from: string[]; to: string[] };
      aboutOthers: { from: number; to: number };
    };

/**
 * A note event as `reach` may read it. The stored `about` names the note's
 * own product's items, which a product follower reaches whole; a key reaching
 * the product only through a project gets just the keys of the items it
 * reaches, the rest added to `aboutOthers`. Any other event as stored.
 */
export function eventForReach<
  E extends { subjectType: string; payload: Record<string, unknown> },
>(db: Db, reach: Reach, event: E): E {
  if (
    reach === null ||
    event.subjectType !== "issue" ||
    event.payload.about === undefined
  )
    return event;
  const stored = event.payload as About;
  const created = Array.isArray(stored.about);
  const keys = created
    ? { from: stored.about as string[], to: stored.about as string[] }
    : (stored.about as { from: string[]; to: string[] });
  const others = created
    ? { from: stored.aboutOthers as number, to: stored.aboutOthers as number }
    : (stored.aboutOthers as { from: number; to: number });
  const named = [...new Set([...keys.from, ...keys.to])];
  if (named.length === 0) return event;
  const itemKey = sql<string>`${product.key} || '-' || ${issue.number}`;
  const reached = new Set(
    db
      .select({ key: itemKey })
      .from(issue)
      .innerJoin(product, eq(product.id, issue.productId))
      .where(
        and(
          inArray(itemKey, named),
          itemsReached(db, reach, issue.id, issue.productId),
        ),
      )
      .all()
      .map((r) => r.key),
  );
  const shown = (side: string[]) => side.filter((k) => reached.has(k));
  const from = shown(keys.from);
  const to = shown(keys.to);
  const fromOthers = others.from + keys.from.length - from.length;
  const toOthers = others.to + keys.to.length - to.length;
  const about: About = created
    ? { about: to, aboutOthers: toOthers }
    : {
        about: { from, to },
        aboutOthers: { from: fromOthers, to: toOthers },
      };
  return { ...event, payload: { ...event.payload, ...about } };
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
