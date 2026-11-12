import { createRoute } from "@hono/zod-openapi";
import { and, asc, desc, eq, or, type SQLWrapper, sql } from "drizzle-orm";
import { searchQuerySchema, searchSchema } from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { issue, project } from "../db/schema.js";
import { amongVisible } from "../service/visible.js";
import { createWebRouter } from "./env.js";
import { visibleIds } from "./visible.js";

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
    const issueKey = sql`${project.key} || '-' || ${issue.number}`;
    const issues = db
      .select({
        key: sql<string>`${issueKey}`,
        sourceKey: issue.sourceKey,
        title: issue.title,
        status: issue.status,
        projectKey: project.key,
        projectName: project.name,
      })
      .from(issue)
      .innerJoin(project, eq(project.id, issue.projectId))
      .where(
        and(
          amongVisible(issue.projectId, ids),
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
      .select({ key: project.key, name: project.name })
      .from(project)
      .where(
        and(
          amongVisible(project.id, ids),
          or(contains(project.key, q), contains(project.name, q)),
        ),
      )
      .orderBy(asc(project.key))
      .limit(SEARCH_LIMIT)
      .all();
    return c.json(
      {
        issues: issues.map(({ projectKey, projectName, ...rest }) => ({
          ...rest,
          project: { key: projectKey, name: projectName },
        })),
        projects,
      },
      200,
    );
  });
}
