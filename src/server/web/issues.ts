import { createRoute } from "@hono/zod-openapi";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  entrySchema,
  errorSchema,
  type WebIssueRowView,
  type WebIssueView,
  webCommentCreateSchema,
  webIssueCreateSchema,
  webIssueListQuerySchema,
  webIssueListSchema,
  webIssueSchema,
} from "../../shared/schemas.js";
import { jsonBody, jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { issue, issueLabel, issueLink, label, project } from "../db/schema.js";
import type { ActingActor, Service } from "../service/index.js";
import { page } from "../service/paging.js";
import { photoUrlOf } from "../service/photos.js";
import { amongVisible, noIssue } from "../service/visible.js";
import { timelineOf } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import { keyParam } from "./projects.js";
import { actorsById, visibleIds, visibleProject } from "./visible.js";

type IssueRow = typeof issue.$inferSelect;

const listIssues = createRoute({
  method: "get",
  path: "/projects/{key}/issues",
  request: { params: keyParam, query: webIssueListQuerySchema },
  responses: {
    200: jsonContent(webIssueListSchema, "The project's issues, newest first"),
    404: jsonContent(errorSchema, "No such project"),
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/issues/{key}",
  request: { params: keyParam },
  responses: {
    200: jsonContent(webIssueSchema, "The issue and its timeline"),
    404: jsonContent(errorSchema, "No such issue"),
  },
});

const createIssue = createRoute({
  method: "post",
  path: "/issues",
  request: { body: jsonBody(webIssueCreateSchema) },
  responses: {
    201: jsonContent(webIssueSchema, "The filed issue"),
    404: jsonContent(errorSchema, "No such project"),
  },
});

const createComment = createRoute({
  method: "post",
  path: "/issues/{key}/comments",
  request: { params: keyParam, body: jsonBody(webCommentCreateSchema) },
  responses: {
    201: jsonContent(entrySchema, "The comment, as a timeline entry"),
    404: jsonContent(errorSchema, "No such issue"),
  },
});

// a project key, a dash and the issue's number: TRL-12
const issueKeyPattern = /^([A-Za-z0-9]{2,10})-(\d+)$/;

/**
 * The issue in a visible project with this key (TRL-12), else this source key
 * (JUS-187), in any case. Only visible issues are searched, so a hidden issue
 * is found no more than a missing one.
 */
export function visibleIssue(db: Db, member: Member, ref: string) {
  const ids = visibleIds(member);
  const columns = { issue, projectKey: project.key, projectName: project.name };
  const visible = and(
    amongVisible(issue.projectId, ids),
    eq(project.id, issue.projectId),
  );
  const match = issueKeyPattern.exec(ref);
  const byKey =
    match &&
    db
      .select(columns)
      .from(issue)
      .innerJoin(project, visible)
      .where(
        and(
          eq(project.key, (match[1] as string).toUpperCase()),
          eq(issue.number, Number(match[2])),
        ),
      )
      .get();
  const found =
    byKey ||
    db
      .select(columns)
      .from(issue)
      .innerJoin(project, visible)
      .where(eq(issue.sourceKey, ref.trim().toUpperCase()))
      .get();
  if (!found) throw noIssue(ref);
  return {
    row: found.issue,
    key: `${found.projectKey}-${found.issue.number}`,
    project: { key: found.projectKey, name: found.projectName },
  };
}

/** The issue `visibleIssue` found, for display, with its timeline. */
export function issueView(
  db: Db,
  { row, key, project: projectRef }: ReturnType<typeof visibleIssue>,
): WebIssueView {
  const links = db
    .select({ url: issueLink.url, title: issueLink.title })
    .from(issueLink)
    .where(eq(issueLink.issueId, row.id))
    // rowid is the order the links were set in
    .orderBy(sql`rowid`)
    .all();
  const actorOf = actorsById(db, [row.createdBy, row.assigneeId]);
  return {
    key,
    sourceKey: row.sourceKey,
    project: projectRef,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimate: row.estimate,
    labels: labelsOf(db, [row.id])(row.id),
    links,
    assignee: row.assigneeId === null ? null : actorOf(row.assigneeId),
    creator: actorOf(row.createdBy),
    sourceAuthor: row.sourceAuthor,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    timeline: timelineOf(db, row, { key, title: row.title }, projectRef),
  };
}

/** Each issue's label names, A to Z. */
export function labelsOf(db: Db, issueIds: string[]): (id: string) => string[] {
  const rows =
    issueIds.length === 0
      ? []
      : db
          .select({ issueId: issueLabel.issueId, name: label.name })
          .from(issueLabel)
          .innerJoin(label, eq(label.id, issueLabel.labelId))
          .where(inArray(issueLabel.issueId, issueIds))
          .orderBy(asc(label.name))
          .all();
  return (id) => rows.filter((r) => r.issueId === id).map((r) => r.name);
}

function toRows(
  db: Db,
  projectKey: string,
  rows: IssueRow[],
): WebIssueRowView[] {
  const labels = labelsOf(
    db,
    rows.map((r) => r.id),
  );
  const actorOf = actorsById(
    db,
    rows.map((r) => r.assigneeId),
  );
  return rows.map((r) => ({
    key: `${projectKey}-${r.number}`,
    title: r.title,
    status: r.status,
    priority: r.priority,
    labels: labels(r.id),
    assignee: r.assigneeId === null ? null : actorOf(r.assigneeId),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

function statusCounts(db: Db, projectId: string) {
  const rows = db
    .select({ status: issue.status, n: count() })
    .from(issue)
    .where(eq(issue.projectId, projectId))
    .groupBy(issue.status)
    .all();
  const counts = { all: 0, open: 0, in_progress: 0, done: 0, canceled: 0 };
  for (const row of rows) {
    counts[row.status] = row.n;
    counts.all += row.n;
  }
  return counts;
}

const actingAs = (member: Member): ActingActor => ({
  id: member.actor.id,
  kind: "human",
});

export function issueRoutes(db: Db, service: Service) {
  return createWebRouter()
    .openapi(createIssue, (c) => {
      const member = c.var.member;
      const { projectKey, title, description } = c.req.valid("json");
      const target = visibleProject(member, projectKey);
      const created = service.createIssue(actingAs(member), {
        projectId: target.id,
        title,
        description,
      });
      return c.json(issueView(db, visibleIssue(db, member, created.key)), 201);
    })
    .openapi(createComment, (c) => {
      const member = c.var.member;
      const found = visibleIssue(db, member, c.req.valid("param").key);
      const created = service.addComment(actingAs(member), {
        issueId: found.row.id,
        body: c.req.valid("json").body,
      });
      return c.json(
        {
          id: created.id,
          kind: "comment" as const,
          createdAt: created.createdAt.toISOString(),
          actor: {
            id: member.actor.id,
            name: member.actor.displayName,
            kind: "human" as const,
            photoUrl: photoUrlOf(db, member.actor.id),
          },
          project: found.project,
          issue: { key: found.key, title: found.row.title },
          comment: { id: created.id, body: created.body, sourceAuthor: null },
        },
        201,
      );
    })
    .openapi(getIssue, (c) =>
      c.json(
        issueView(db, visibleIssue(db, c.var.member, c.req.valid("param").key)),
        200,
      ),
    )
    .openapi(listIssues, (c) => {
      const target = visibleProject(c.var.member, c.req.valid("param").key);
      const { status, ...query } = c.req.valid("query");
      const rows = page(
        issue,
        "desc",
        query,
        [
          eq(issue.projectId, target.id),
          status === undefined ? undefined : eq(issue.status, status),
        ],
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
          items: toRows(db, target.key, rows.items),
          nextCursor: rows.nextCursor,
          counts: statusCounts(db, target.id),
        },
        200,
      );
    });
}
