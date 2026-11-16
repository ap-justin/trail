import { createRoute } from "@hono/zod-openapi";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { searchQuerySchema, searchSchema } from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { issue, product, project } from "../db/schema.js";
import { amongVisible } from "../service/visible.js";
import { createWebRouter } from "./env.js";
import { projectIdsAmong, visibleIds } from "./visible.js";

const SEARCH_LIMIT = 20;

const search = createRoute({
  method: "get",
  path: "/search",
  request: { query: searchQuerySchema },
  responses: {
    200: jsonContent(
      searchSchema,
      `Up to ${SEARCH_LIMIT} each of visible items (newest first), products (A to Z by key) and projects (A to Z by name)`,
    ),
  },
});

/** `column` contains `text`, ignoring the case of A-Z, with % and _ in `text` matched as themselves. */
const contains = (column: SQLWrapper, text: string) =>
  sql`${column} like ${`%${text.replace(/[\\%_]/g, "\\$&")}%`} escape '\\'`;

export function searchRoutes(db: Db) {
  return createWebRouter().openapi(search, (c) => {
    const { q } = c.req.valid("query");
    const ids = visibleIds(c.var.member);
    const itemKey = sql`${product.key} || '-' || ${issue.number}`;
    const exact = q.trim().toUpperCase();
    const items = db
      .select({
        key: sql<string>`${itemKey}`,
        sourceKey: issue.sourceKey,
        title: issue.title,
        type: issue.type,
        status: issue.status,
        productKey: product.key,
        productName: product.name,
      })
      .from(issue)
      .innerJoin(product, eq(product.id, issue.productId))
      .where(
        and(
          amongVisible(issue.productId, ids),
          or(
            contains(issue.title, q),
            contains(itemKey, q),
            contains(issue.sourceKey, q),
          ),
        ),
      )
      // an item the query names exactly first, so newer items whose keys merely contain it can't crowd it out
      .orderBy(
        sql`case when upper(${itemKey}) = ${exact} or ${issue.sourceKey} = ${exact} then 0 else 1 end`,
        desc(issue.createdAt),
        desc(issue.id),
      )
      .limit(SEARCH_LIMIT)
      .all();
    const products = db
      .select({ key: product.key, name: product.name })
      .from(product)
      .where(
        and(
          amongVisible(product.id, ids),
          or(contains(product.key, q), contains(product.name, q)),
        ),
      )
      .orderBy(asc(product.key))
      .limit(SEARCH_LIMIT)
      .all();
    const projects = db
      .select({ slug: project.slug, name: project.name })
      .from(project)
      .where(
        and(
          inArray(project.id, projectIdsAmong(db, ids)),
          or(contains(project.slug, q), contains(project.name, q)),
        ),
      )
      .orderBy(asc(project.name), asc(project.slug))
      .limit(SEARCH_LIMIT)
      .all();
    return c.json(
      {
        items: items.map(({ productKey, productName, ...rest }) => ({
          ...rest,
          product: { key: productKey, name: productName },
        })),
        products,
        projects,
      },
      200,
    );
  });
}
