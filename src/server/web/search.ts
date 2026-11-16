import { createRoute } from "@hono/zod-openapi";
import { and, asc, desc, eq, or, type SQLWrapper, sql } from "drizzle-orm";
import { searchQuerySchema, searchSchema } from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { issue, product } from "../db/schema.js";
import { amongVisible } from "../service/visible.js";
import { createWebRouter } from "./env.js";
import { visibleIds, webStatus } from "./visible.js";

const SEARCH_LIMIT = 20;

const search = createRoute({
  method: "get",
  path: "/search",
  request: { query: searchQuerySchema },
  responses: {
    200: jsonContent(
      searchSchema,
      `Up to ${SEARCH_LIMIT} visible issues, newest first, and projects`,
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
    const issueKey = sql`${product.key} || '-' || ${issue.number}`;
    const issues = db
      .select({
        key: sql<string>`${issueKey}`,
        sourceKey: issue.sourceKey,
        title: issue.title,
        status: issue.status,
        projectKey: product.key,
        projectName: product.name,
      })
      .from(issue)
      .innerJoin(product, eq(product.id, issue.productId))
      .where(
        and(
          amongVisible(issue.productId, ids),
          or(
            contains(issue.title, q),
            contains(issueKey, q),
            contains(issue.sourceKey, q),
          ),
        ),
      )
      .orderBy(desc(issue.createdAt), desc(issue.id))
      .limit(SEARCH_LIMIT)
      .all();
    const projects = db
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
    return c.json(
      {
        issues: issues.map(({ projectKey, projectName, status, ...rest }) => ({
          ...rest,
          status: webStatus(status),
          project: { key: projectKey, name: projectName },
        })),
        projects,
      },
      200,
    );
  });
}
