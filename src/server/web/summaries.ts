import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type {
  WebProductView,
  WebProjectView,
  WebStatusUpdateView,
} from "../../shared/schemas.js";
import type { Db } from "../db/client.js";
import {
  issue,
  product,
  productStatusUpdate,
  type project,
  projectItem,
  projectProduct,
  projectStatusUpdate,
} from "../db/schema.js";
import { actorsById } from "./visible.js";

type StatusUpdateRow = {
  id: string;
  body: string;
  health: WebStatusUpdateView["health"];
  authorId: string;
  createdAt: Date;
  sourceAuthor?: string | null;
};

/** Product or project status updates for display, in the order given. */
export function toStatusUpdates(
  db: Db,
  rows: StatusUpdateRow[],
): WebStatusUpdateView[] {
  const actorOf = actorsById(
    db,
    rows.map((r) => r.authorId),
  );
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    health: r.health,
    author: actorOf(r.authorId),
    sourceAuthor: r.sourceAuthor ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

const latestTime = (...times: (Date | string | null | undefined)[]) =>
  new Date(
    Math.max(
      ...times.map((t) =>
        t == null ? 0 : typeof t === "string" ? Date.parse(t) : t.getTime(),
      ),
    ),
  ).toISOString();

/** The products with these ids, A to Z by key, each with its counts and latest status update. */
export function productSummaries(db: Db, ids: string[]): WebProductView[] {
  if (ids.length === 0) return [];
  const rows = db
    .select()
    .from(product)
    .where(inArray(product.id, ids))
    .orderBy(asc(product.key))
    .all();
  const items = db
    .select({
      productId: issue.productId,
      openIssues: sql<number>`sum(${issue.type} = 'issue' and ${issue.status} in ('triage', 'open'))`,
      openTodos: sql<number>`sum(${issue.type} = 'todo' and ${issue.status} = 'open')`,
      updatedAt: max(issue.updatedAt),
    })
    .from(issue)
    .where(inArray(issue.productId, ids))
    .groupBy(issue.productId)
    .all();
  const projects = db
    .select({ productId: projectProduct.productId, n: sql<number>`count(*)` })
    .from(projectProduct)
    .where(inArray(projectProduct.productId, ids))
    .groupBy(projectProduct.productId)
    .all();
  const latest = db
    .select()
    .from(productStatusUpdate)
    .where(
      and(
        inArray(productStatusUpdate.productId, ids),
        // the product's newest by (created_at, id), the order its list pages in
        eq(
          productStatusUpdate.id,
          sql`(select s.id from ${productStatusUpdate} s where s.product_id = ${productStatusUpdate.productId} order by s.created_at desc, s.id desc limit 1)`,
        ),
      ),
    )
    .all();
  const views = toStatusUpdates(db, latest);
  const updates = new Map(latest.map((row, i) => [row.productId, views[i]]));
  return rows.map((p) => {
    const counts = items.find((c) => c.productId === p.id);
    const update = updates.get(p.id) ?? null;
    return {
      key: p.key,
      name: p.name,
      description: p.description,
      repoUrl: p.repoUrl,
      health: update?.health ?? null,
      latestStatusUpdate: update,
      openIssues: counts?.openIssues ?? 0,
      openTodos: counts?.openTodos ?? 0,
      projectCount: projects.find((c) => c.productId === p.id)?.n ?? 0,
      updatedAt: latestTime(p.updatedAt, counts?.updatedAt, update?.createdAt),
    };
  });
}

type ProjectRow = typeof project.$inferSelect;

/**
 * These projects as a viewer of `visible` products sees them, in the order
 * given: only the visible products, and the open count over their items alone.
 */
export function projectSummaries(
  db: Db,
  rows: ProjectRow[],
  visible: string[],
): WebProjectView[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const products = db
    .select({
      projectId: projectProduct.projectId,
      key: product.key,
      name: product.name,
    })
    .from(projectProduct)
    .innerJoin(product, eq(product.id, projectProduct.productId))
    .where(
      and(
        inArray(projectProduct.projectId, ids),
        inArray(projectProduct.productId, visible),
      ),
    )
    .orderBy(asc(product.key))
    .all();
  const open = db
    .select({ projectId: projectItem.projectId, n: sql<number>`count(*)` })
    .from(projectItem)
    .innerJoin(issue, eq(issue.id, projectItem.issueId))
    .where(
      and(
        inArray(projectItem.projectId, ids),
        inArray(projectItem.productId, visible),
        inArray(issue.status, ["triage", "open"]),
      ),
    )
    .groupBy(projectItem.projectId)
    .all();
  const latest = db
    .select()
    .from(projectStatusUpdate)
    .where(
      and(
        inArray(projectStatusUpdate.projectId, ids),
        eq(
          projectStatusUpdate.id,
          sql`(select s.id from ${projectStatusUpdate} s where s.project_id = ${projectStatusUpdate.projectId} order by s.created_at desc, s.id desc limit 1)`,
        ),
      ),
    )
    .all();
  const views = toStatusUpdates(db, latest);
  const updates = new Map(latest.map((row, i) => [row.projectId, views[i]]));
  const leadOf = actorsById(
    db,
    rows.map((r) => r.leadId),
  );
  return rows.map((p) => {
    const update = updates.get(p.id) ?? null;
    return {
      slug: p.slug,
      name: p.name,
      goal: p.goal,
      health: update?.health ?? null,
      latestStatusUpdate: update,
      lead: leadOf(p.leadId),
      targetDate: p.targetDate,
      products: products
        .filter((x) => x.projectId === p.id)
        .map(({ key, name }) => ({ key, name })),
      openCount: open.find((x) => x.projectId === p.id)?.n ?? 0,
      updatedAt: latestTime(p.updatedAt, update?.createdAt),
    };
  });
}
