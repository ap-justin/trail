import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, count, eq, inArray, max, sql } from "drizzle-orm";
import {
  errorSchema,
  pageQuerySchema,
  type WebProjectView,
  type WebStatusUpdateView,
  webProjectListSchema,
  webProjectSchema,
  webStatusUpdatePageSchema,
} from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { issue, product, productStatusUpdate } from "../db/schema.js";
import { page } from "../service/paging.js";
import { createWebRouter } from "./env.js";
import { actorsById, visibleIds, visibleProject } from "./visible.js";

export const keyParam = z.object({ key: z.string().min(1) });

const notFound = { 404: jsonContent(errorSchema, "No such project") };

const listProjects = createRoute({
  method: "get",
  path: "/projects",
  responses: { 200: jsonContent(webProjectListSchema, "The visible projects") },
});

const getProject = createRoute({
  method: "get",
  path: "/projects/{key}",
  request: { params: keyParam },
  responses: { 200: jsonContent(webProjectSchema, "The project"), ...notFound },
});

const listStatusUpdates = createRoute({
  method: "get",
  path: "/projects/{key}/status-updates",
  request: { params: keyParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(webStatusUpdatePageSchema, "Status updates, newest first"),
    ...notFound,
  },
});

type StatusUpdateRow = typeof productStatusUpdate.$inferSelect;

function toStatusUpdates(
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
    sourceAuthor: r.sourceAuthor,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The projects with these ids, A to Z by key, each with its counts and latest status update. */
export function projectSummaries(db: Db, ids: string[]): WebProjectView[] {
  if (ids.length === 0) return [];
  const rows = db
    .select()
    .from(product)
    .where(inArray(product.id, ids))
    .orderBy(asc(product.key))
    .all();
  const counts = db
    .select({
      projectId: issue.productId,
      status: issue.status,
      n: count(),
      updatedAt: max(issue.updatedAt),
    })
    .from(issue)
    .where(inArray(issue.productId, ids))
    .groupBy(issue.productId, issue.status)
    .all();
  const latest = db
    .select()
    .from(productStatusUpdate)
    .where(
      and(
        inArray(productStatusUpdate.productId, ids),
        // the project's newest by (created_at, id), the order its list pages in
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
    const mine = counts.filter((c) => c.projectId === p.id);
    const countOf = (status: string) =>
      mine.find((c) => c.status === status)?.n ?? 0;
    const update = updates.get(p.id) ?? null;
    const times = [
      p.updatedAt.getTime(),
      ...mine.map((c) => c.updatedAt?.getTime() ?? 0),
      update ? Date.parse(update.createdAt) : 0,
    ];
    return {
      key: p.key,
      name: p.name,
      description: p.description,
      health: update?.health ?? null,
      latestStatusUpdate: update,
      openCount: countOf("open"),
      inProgressCount: countOf("in_progress"),
      updatedAt: new Date(Math.max(...times)).toISOString(),
    };
  });
}

export function projectRoutes(db: Db) {
  return createWebRouter()
    .openapi(listProjects, (c) =>
      c.json({ items: projectSummaries(db, visibleIds(c.var.member)) }, 200),
    )
    .openapi(getProject, (c) => {
      const target = visibleProject(c.var.member, c.req.valid("param").key);
      return c.json(
        projectSummaries(db, [target.id])[0] as WebProjectView,
        200,
      );
    })
    .openapi(listStatusUpdates, (c) => {
      const target = visibleProject(c.var.member, c.req.valid("param").key);
      const rows = page(
        productStatusUpdate,
        "desc",
        c.req.valid("query"),
        [eq(productStatusUpdate.productId, target.id)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(productStatusUpdate)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return c.json(
        { items: toStatusUpdates(db, rows.items), nextCursor: rows.nextCursor },
        200,
      );
    });
}
