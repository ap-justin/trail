import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  entrySchema,
  errorSchema,
  type WebItemCountsView,
  type WebItemRowView,
  type WebItemStatus,
  type WebItemType,
  type WebItemView,
  type WebStatusCountsView,
  webCommentCreateSchema,
  webIssueCreateSchema,
  webItemSchema,
} from "../../shared/schemas.js";
import { jsonBody, jsonContent } from "../api/routes.js";
import { toLink } from "../api/serialize.js";
import type { Db } from "../db/client.js";
import {
  issue,
  issueLabel,
  issueLink,
  label,
  noteAbout,
  product,
  project,
  projectItem,
} from "../db/schema.js";
import { NotFoundError } from "../service/errors.js";
import { isNoteStatus, type Service } from "../service/index.js";
import { photoUrlOf } from "../service/photos.js";
import { amongProducts } from "../service/visible.js";
import { timelineOf } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import { actingAs, actorsById, visibleIds, visibleProduct } from "./visible.js";

type IssueRow = typeof issue.$inferSelect;

const keyParam = z.object({ key: z.string().min(1).max(200) });

const getItem = createRoute({
  method: "get",
  path: "/items/{key}",
  request: { params: keyParam },
  responses: {
    200: jsonContent(webItemSchema, "The item and its timeline"),
    404: jsonContent(errorSchema, "No such item"),
  },
});

const createIssue = createRoute({
  method: "post",
  path: "/issues",
  request: { body: jsonBody(webIssueCreateSchema) },
  responses: {
    201: jsonContent(webItemSchema, "The filed issue, in triage"),
    404: jsonContent(errorSchema, "No such product"),
  },
});

const createComment = createRoute({
  method: "post",
  path: "/items/{key}/comments",
  request: { params: keyParam, body: jsonBody(webCommentCreateSchema) },
  responses: {
    201: jsonContent(entrySchema, "The comment, as a timeline entry"),
    404: jsonContent(errorSchema, "No such item"),
  },
});

// a product key, a dash and the item's number: TRL-12
const itemKeyPattern = /^([A-Za-z0-9]{2,10})-(\d+)$/;

/**
 * The item in a visible product with this key (TRL-12), else this source key
 * (ABC-187), in any case. Only visible items are searched, so a hidden item
 * is found no more than a missing one.
 */
export function visibleItem(db: Db, member: Member, ref: string) {
  const ids = visibleIds(member);
  const columns = { issue, productKey: product.key, productName: product.name };
  const visible = and(
    amongProducts(issue.productId, ids),
    eq(product.id, issue.productId),
  );
  const match = itemKeyPattern.exec(ref);
  const byKey =
    match &&
    db
      .select(columns)
      .from(issue)
      .innerJoin(product, visible)
      .where(
        and(
          eq(product.key, (match[1] as string).toUpperCase()),
          eq(issue.number, Number(match[2])),
        ),
      )
      .get();
  const found =
    byKey ||
    db
      .select(columns)
      .from(issue)
      .innerJoin(product, visible)
      .where(eq(issue.sourceKey, ref.trim().toUpperCase()))
      .get();
  if (!found) throw new NotFoundError(`no item ${ref}`);
  return {
    row: found.issue,
    key: `${found.productKey}-${found.issue.number}`,
    product: { key: found.productKey, name: found.productName },
  };
}

/** The item `visibleItem` found, for display, with its projects, timeline and pull request states. */
export function itemView(
  db: Db,
  service: Service,
  member: Member,
  { row, key, product: productRef }: ReturnType<typeof visibleItem>,
): WebItemView {
  const links = db
    .select({ url: issueLink.url, title: issueLink.title })
    .from(issueLink)
    .where(eq(issueLink.issueId, row.id))
    // rowid is the order the links were set in
    .orderBy(sql`rowid`)
    .all();
  // every project an item is in draws from the item's product, which the viewer sees
  const projects = db
    .select({ slug: project.slug, name: project.name })
    .from(projectItem)
    .innerJoin(project, eq(project.id, projectItem.projectId))
    .where(eq(projectItem.issueId, row.id))
    .orderBy(asc(project.name), asc(project.slug))
    .all();
  const actorOf = actorsById(db, [row.createdBy, row.assigneeId]);
  return {
    key,
    type: row.type,
    sourceKey: row.sourceKey,
    product: productRef,
    projects,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimate: row.estimate,
    labels: labelsOf(db, [row.id])(row.id),
    links: service.withPullRequestLinks(links).map(toLink),
    assignee: row.assigneeId === null ? null : actorOf(row.assigneeId),
    creator: actorOf(row.createdBy),
    sourceAuthor: row.sourceAuthor,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    about:
      row.type === "note"
        ? linkedItems(
            db,
            member,
            noteAbout.itemId,
            eq(noteAbout.noteId, row.id),
          )
        : [],
    notes: linkedItems(
      db,
      member,
      noteAbout.noteId,
      eq(noteAbout.itemId, row.id),
    ),
    timeline: timelineOf(
      db,
      row,
      { key, title: row.title, type: row.type },
      productRef,
    ),
  };
}

/**
 * The items at the `end` of the note_about rows `where` picks that the
 * viewer sees: the items a note is about in key order, or the notes about an
 * item newest first.
 */
function linkedItems(
  db: Db,
  member: Member,
  end: typeof noteAbout.itemId | typeof noteAbout.noteId,
  where: SQL,
) {
  return db
    .select({
      key: sql<string>`${product.key} || '-' || ${issue.number}`,
      title: issue.title,
      type: issue.type,
      status: issue.status,
    })
    .from(noteAbout)
    .innerJoin(issue, eq(issue.id, end))
    .innerJoin(product, eq(product.id, issue.productId))
    .where(and(where, amongProducts(issue.productId, visibleIds(member))))
    .orderBy(
      ...(end === noteAbout.itemId
        ? [asc(product.key), asc(issue.number)]
        : [desc(issue.createdAt), desc(issue.id)]),
    )
    .all();
}

/** Each item's label names, A to Z. */
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

/** These items as list rows, keyed under their product's key. */
export function itemRows(
  db: Db,
  rows: (IssueRow & { productKey: string })[],
): WebItemRowView[] {
  const labels = labelsOf(
    db,
    rows.map((r) => r.id),
  );
  const actorOf = actorsById(
    db,
    rows.map((r) => r.assigneeId),
  );
  return rows.map((r) => ({
    key: `${r.productKey}-${r.number}`,
    type: r.type,
    title: r.title,
    status: r.status,
    priority: r.priority,
    labels: labels(r.id),
    assignee: r.assigneeId === null ? null : actorOf(r.assigneeId),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** The type and status filters of an item list, issues and todos without a type; `open` takes triage too, as the Open tab counts it. */
export function itemFilters(query: {
  type?: WebItemType;
  status?: WebItemStatus;
}): (SQL | undefined)[] {
  const { type, status } = query;
  return [
    type === undefined
      ? inArray(issue.type, ["issue", "todo"])
      : eq(issue.type, type),
    status === undefined
      ? undefined
      : status === "open"
        ? inArray(issue.status, ["triage", "open"])
        : eq(issue.status, status),
  ];
}

const noCounts = (): WebStatusCountsView => ({
  all: 0,
  open: 0,
  in_progress: 0,
  done: 0,
  canceled: 0,
});

/** Items per type and status tab among the items `where` picks, triage counted as open, and notes apart. */
export function itemCounts(db: Db, where: SQL | undefined): WebItemCountsView {
  const counts = {
    all: noCounts(),
    issue: noCounts(),
    todo: noCounts(),
    notes: { current: 0, archived: 0 },
  };
  const rows = db
    .select({
      type: issue.type,
      status: issue.status,
      n: sql<number>`count(*)`,
    })
    .from(issue)
    .where(where)
    .groupBy(issue.type, issue.status)
    .all();
  for (const { type, status, n } of rows) {
    if (type === "note") {
      if (isNoteStatus(status)) counts.notes[status] += n;
      continue;
    }
    if (isNoteStatus(status)) continue;
    const tab = status === "triage" ? "open" : status;
    for (const bucket of [counts.all, counts[type]]) {
      bucket.all += n;
      bucket[tab] += n;
    }
  }
  return counts;
}

export function itemRoutes(db: Db, service: Service) {
  return createWebRouter()
    .openapi(createIssue, (c) => {
      const member = c.var.member;
      const { product: key, title, description } = c.req.valid("json");
      const target = visibleProduct(member, key);
      const created = service.fileIssue(actingAs(member), {
        product: target.id,
        title,
        description,
      });
      return c.json(
        itemView(db, service, member, visibleItem(db, member, created.key)),
        201,
      );
    })
    .openapi(createComment, (c) => {
      const member = c.var.member;
      const found = visibleItem(db, member, c.req.valid("param").key);
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
            title: null,
          },
          product: found.product,
          project: null,
          item: {
            key: found.key,
            title: found.row.title,
            type: found.row.type,
          },
          comment: { id: created.id, body: created.body, sourceAuthor: null },
        },
        201,
      );
    })
    .openapi(getItem, (c) =>
      c.json(
        itemView(
          db,
          service,
          c.var.member,
          visibleItem(db, c.var.member, c.req.valid("param").key),
        ),
        200,
      ),
    );
}
