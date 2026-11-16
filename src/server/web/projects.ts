import { createRoute, z } from "@hono/zod-openapi";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  errorSchema,
  pageQuerySchema,
  type WebProjectDetailView,
  type WebProjectView,
  webProjectDetailSchema,
  webProjectItemsQuerySchema,
  webProjectItemsSchema,
  webProjectPageSchema,
  webStatusUpdatePageSchema,
} from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import {
  issue,
  product,
  project,
  projectItem,
  projectProduct,
  projectStatusUpdate,
} from "../db/schema.js";
import { NotFoundError, ValidationError } from "../service/errors.js";
import { page, pageLimit } from "../service/paging.js";
import { createWebRouter } from "./env.js";
import { itemCounts, itemFilters, itemRows } from "./items.js";
import { projectSummaries, toStatusUpdates } from "./summaries.js";
import { projectIdsAmong, visibleIds, visibleProject } from "./visible.js";

const slugParam = z.object({ slug: z.string().min(1).max(100) });

const notFound = { 404: jsonContent(errorSchema, "No such project") };

const listProjects = createRoute({
  method: "get",
  path: "/projects",
  request: { query: pageQuerySchema },
  responses: {
    200: jsonContent(
      webProjectPageSchema,
      "The projects drawing from a product the viewer sees, newest first",
    ),
  },
});

const getProject = createRoute({
  method: "get",
  path: "/projects/{slug}",
  request: { params: slugParam },
  responses: {
    200: jsonContent(webProjectDetailSchema, "The project"),
    ...notFound,
  },
});

const listItems = createRoute({
  method: "get",
  path: "/projects/{slug}/items",
  request: { params: slugParam, query: webProjectItemsQuerySchema },
  responses: {
    200: jsonContent(
      webProjectItemsSchema,
      "The project's items of visible products, grouped by product",
    ),
    ...notFound,
    422: jsonContent(errorSchema, "A cursor this list didn't issue"),
  },
});

const listStatusUpdates = createRoute({
  method: "get",
  path: "/projects/{slug}/status-updates",
  request: { params: slugParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(webStatusUpdatePageSchema, "Status updates, newest first"),
    ...notFound,
  },
});

const encodeCursor = (row: { key: string; createdAt: Date; id: string }) =>
  Buffer.from(
    JSON.stringify([row.key, row.createdAt.getTime(), row.id]),
  ).toString("base64url");

function decodeCursor(cursor: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {}
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "string" ||
    !Number.isSafeInteger(parsed[1]) ||
    typeof parsed[2] !== "string"
  ) {
    throw new ValidationError(
      "cursor is invalid: pass a nextCursor exactly as the previous page returned it, or leave cursor out for the first page",
    );
  }
  return {
    key: parsed[0] as string,
    createdAt: new Date(parsed[1] as number),
    id: parsed[2] as string,
  };
}

/** Rows after the cursor in (product key A to Z, then newest first) order. */
function pastCursor(cursor: string): SQL {
  const after = decodeCursor(cursor);
  return or(
    gt(product.key, after.key),
    and(
      eq(product.key, after.key),
      or(
        lt(issue.createdAt, after.createdAt),
        and(eq(issue.createdAt, after.createdAt), lt(issue.id, after.id)),
      ),
    ),
  ) as SQL;
}

export function projectRoutes(db: Db) {
  return createWebRouter()
    .openapi(listProjects, (c) => {
      const ids = visibleIds(c.var.member);
      const rows = page(
        project,
        "desc",
        c.req.valid("query"),
        [inArray(project.id, projectIdsAmong(db, ids))],
        (where, orderBy, limit) =>
          db
            .select()
            .from(project)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return c.json(
        {
          items: projectSummaries(db, rows.items, ids),
          nextCursor: rows.nextCursor,
        },
        200,
      );
    })
    .openapi(getProject, (c) => {
      const member = c.var.member;
      const found = visibleProject(db, member, c.req.valid("param").slug);
      const summary = projectSummaries(db, [found], visibleIds(member))[0];
      const { n } = db
        .select({ n: sql<number>`count(*)` })
        .from(projectProduct)
        .where(eq(projectProduct.projectId, found.id))
        .get() ?? { n: 0 };
      const view: WebProjectDetailView = {
        ...(summary as WebProjectView),
        hiddenProducts: (summary as WebProjectView).products.length < n,
      };
      return c.json(view, 200);
    })
    .openapi(listItems, (c) => {
      const member = c.var.member;
      const found = visibleProject(db, member, c.req.valid("param").slug);
      const {
        product: productKey,
        type,
        status,
        cursor,
        limit: asked,
      } = c.req.valid("query");
      const limit = pageLimit(asked);
      // a hidden product of the project is as absent as one it never had
      const visible = visibleIds(member);
      const inProject = db
        .select({ id: product.id, key: product.key, name: product.name })
        .from(projectProduct)
        .innerJoin(product, eq(product.id, projectProduct.productId))
        .where(
          and(
            eq(projectProduct.projectId, found.id),
            inArray(projectProduct.productId, visible),
          ),
        )
        .orderBy(asc(product.key))
        .all();
      const groupsOf =
        productKey === undefined
          ? inProject
          : inProject.filter((p) => p.key === productKey.toUpperCase());
      if (groupsOf.length === 0 && productKey !== undefined) {
        throw new NotFoundError(
          `no product ${productKey} in project ${found.slug}`,
        );
      }
      const scope = and(
        eq(projectItem.projectId, found.id),
        inArray(
          projectItem.productId,
          groupsOf.map((p) => p.id),
        ),
      );
      const filters = itemFilters({ type, status });
      const rows = db
        .select({ issue, key: product.key })
        .from(projectItem)
        .innerJoin(issue, eq(issue.id, projectItem.issueId))
        .innerJoin(product, eq(product.id, projectItem.productId))
        .where(
          and(
            scope,
            ...filters,
            cursor === undefined ? undefined : pastCursor(cursor),
          ),
        )
        .orderBy(asc(product.key), desc(issue.createdAt), desc(issue.id))
        .limit(limit + 1)
        .all();
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      const counted = db
        .select({ productId: projectItem.productId, n: sql<number>`count(*)` })
        .from(projectItem)
        .innerJoin(issue, eq(issue.id, projectItem.issueId))
        .where(and(scope, ...filters))
        .groupBy(projectItem.productId)
        .all();
      const listed = itemRows(
        db,
        shown.map((r) => ({ ...r.issue, productKey: r.key })),
      );
      const groups = groupsOf.flatMap((p) => {
        const items = listed.filter((_, i) => shown[i]?.key === p.key);
        if (items.length === 0) return [];
        return [
          {
            product: { key: p.key, name: p.name },
            count: counted.find((x) => x.productId === p.id)?.n ?? 0,
            items,
          },
        ];
      });
      return c.json(
        {
          groups,
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({
                  key: last.key,
                  createdAt: last.issue.createdAt,
                  id: last.issue.id,
                })
              : null,
          counts: itemCounts(
            db,
            inArray(
              issue.id,
              db
                .select({ id: projectItem.issueId })
                .from(projectItem)
                .where(scope),
            ),
          ),
        },
        200,
      );
    })
    .openapi(listStatusUpdates, (c) => {
      const found = visibleProject(db, c.var.member, c.req.valid("param").slug);
      const rows = page(
        projectStatusUpdate,
        "desc",
        c.req.valid("query"),
        [eq(projectStatusUpdate.projectId, found.id)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(projectStatusUpdate)
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
