import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq, inArray } from "drizzle-orm";
import {
  errorSchema,
  pageQuerySchema,
  WEB_PRODUCT_PROJECTS_MAX,
  type WebProductView,
  webItemListQuerySchema,
  webItemListSchema,
  webProductDetailSchema,
  webProductListSchema,
  webStatusUpdatePageSchema,
} from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import {
  issue,
  product,
  productStatusUpdate,
  project,
  projectProduct,
} from "../db/schema.js";
import { page } from "../service/paging.js";
import { createWebRouter } from "./env.js";
import { itemCounts, itemFilters, itemRows } from "./items.js";
import {
  productSummaries,
  projectSummaries,
  toStatusUpdates,
} from "./summaries.js";
import { actorsById, visibleIds, visibleProduct } from "./visible.js";

const productParam = z.object({ key: z.string().min(1).max(10) });

const notFound = { 404: jsonContent(errorSchema, "No such product") };

const listProducts = createRoute({
  method: "get",
  path: "/products",
  responses: {
    200: jsonContent(webProductListSchema, "The visible products, A to Z"),
  },
});

const getProduct = createRoute({
  method: "get",
  path: "/products/{key}",
  request: { params: productParam },
  responses: {
    200: jsonContent(webProductDetailSchema, "The product"),
    ...notFound,
  },
});

const listItems = createRoute({
  method: "get",
  path: "/products/{key}/items",
  request: { params: productParam, query: webItemListQuerySchema },
  responses: {
    200: jsonContent(webItemListSchema, "The product's items, newest first"),
    ...notFound,
  },
});

const listStatusUpdates = createRoute({
  method: "get",
  path: "/products/{key}/status-updates",
  request: { params: productParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(webStatusUpdatePageSchema, "Status updates, newest first"),
    ...notFound,
  },
});

export function productRoutes(db: Db) {
  return createWebRouter()
    .openapi(listProducts, (c) =>
      c.json({ items: productSummaries(db, visibleIds(c.var.member)) }, 200),
    )
    .openapi(getProduct, (c) => {
      const member = c.var.member;
      const target = visibleProduct(member, c.req.valid("param").key);
      const summary = productSummaries(db, [target.id])[0] as WebProductView;
      const ownerId =
        db
          .select({ ownerId: product.ownerId })
          .from(product)
          .where(eq(product.id, target.id))
          .get()?.ownerId ?? null;
      const projects = db
        .select()
        .from(project)
        .where(
          inArray(
            project.id,
            db
              .select({ id: projectProduct.projectId })
              .from(projectProduct)
              .where(eq(projectProduct.productId, target.id)),
          ),
        )
        .orderBy(desc(project.createdAt), desc(project.id))
        .limit(WEB_PRODUCT_PROJECTS_MAX)
        .all();
      return c.json(
        {
          ...summary,
          owner: ownerId === null ? null : actorsById(db, [ownerId])(ownerId),
          projects: projectSummaries(db, projects, visibleIds(member)),
        },
        200,
      );
    })
    .openapi(listItems, (c) => {
      const target = visibleProduct(c.var.member, c.req.valid("param").key);
      const { type, status, ...query } = c.req.valid("query");
      const rows = page(
        issue,
        "desc",
        query,
        [eq(issue.productId, target.id), ...itemFilters({ type, status })],
        (where, orderBy, limit) =>
          db
            .select()
            .from(issue)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return c.json(
        {
          items: itemRows(
            db,
            rows.items.map((r) => ({ ...r, productKey: target.key })),
          ),
          nextCursor: rows.nextCursor,
          counts: itemCounts(db, eq(issue.productId, target.id)),
        },
        200,
      );
    })
    .openapi(listStatusUpdates, (c) => {
      const target = visibleProduct(c.var.member, c.req.valid("param").key);
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
