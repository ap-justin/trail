import { createRoute } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, inArray, lt, type SQL } from "drizzle-orm";
import {
  errorSchema,
  type FeedView,
  feedQuerySchema,
  feedSchema,
} from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { activityEvent, actor } from "../db/schema.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedFilters,
  pageLimit,
} from "../service/paging.js";
import { entriesOf, shownEvent } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import { visibleIds, visibleProject } from "./visible.js";

const getFeed = createRoute({
  method: "get",
  path: "/feed",
  request: { query: feedQuerySchema },
  responses: {
    200: jsonContent(
      feedSchema,
      "Entries newest first; limit counts events, and an event that changed several fields is several entries",
    ),
    404: jsonContent(errorSchema, "No such project to filter by"),
    422: jsonContent(errorSchema, "A cursor issued under other filters"),
  },
});

/** The filters a feed or event stream was asked for, the project resolved against the viewer's. */
export function feedFilters(
  member: Member,
  query: { actor?: string; project?: string },
): FeedFilters {
  return {
    projectId:
      query.project === undefined
        ? null
        : visibleProject(member, query.project).id,
    actorId: query.actor ?? null,
  };
}

/** The events these filters show among the projects with these ids, the ids checked inside the query. */
export function feedWhere(projectIds: string[], filters: FeedFilters) {
  return [
    inArray(activityEvent.projectId, projectIds),
    filters.projectId === null
      ? undefined
      : eq(activityEvent.projectId, filters.projectId),
    filters.actorId === null
      ? undefined
      : eq(activityEvent.actorId, filters.actorId),
    shownEvent,
  ];
}

/** Shown events after `seq`, oldest first: what a stream resuming from `seq` missed. */
export function eventsAfter(
  db: Db,
  projectIds: string[],
  filters: FeedFilters,
  seq: number,
) {
  return db
    .select()
    .from(activityEvent)
    .where(and(...feedWhere(projectIds, filters), gt(activityEvent.seq, seq)))
    .orderBy(asc(activityEvent.seq))
    .all();
}

function feedPage(
  db: Db,
  member: Member,
  query: { cursor?: string; limit?: number; actor?: string; project?: string },
): FeedView {
  const limit = pageLimit(query.limit);
  const filters = feedFilters(member, query);
  const ids = visibleIds(member);
  const where: (SQL | undefined)[] = feedWhere(ids, filters);
  if (query.cursor !== undefined) {
    where.push(
      lt(activityEvent.seq, decodeFeedCursor(query.cursor, filters, "cursor")),
    );
  }
  const rows = db
    .select()
    .from(activityEvent)
    .where(and(...where))
    .orderBy(desc(activityEvent.seq))
    .limit(limit + 1)
    .all();
  const events = rows.slice(0, limit);
  const last = events.at(-1);
  return {
    items: entriesOf(db, events),
    nextCursor:
      rows.length > limit && last
        ? encodeFeedCursor({ ...filters, seq: last.seq, param: "cursor" })
        : null,
    filters: {
      actors: botsActingIn(db, ids),
      projects: member.projects.map(({ key, name }) => ({ key, name })),
    },
  };
}

/** The bots with an event in these projects, A to Z. */
function botsActingIn(db: Db, projectIds: string[]) {
  return db
    .select({ id: actor.id, name: actor.displayName, kind: actor.kind })
    .from(actor)
    .where(
      and(
        eq(actor.kind, "bot"),
        inArray(
          actor.id,
          db
            .selectDistinct({ id: activityEvent.actorId })
            .from(activityEvent)
            .where(inArray(activityEvent.projectId, projectIds)),
        ),
      ),
    )
    .orderBy(asc(actor.displayName))
    .all();
}

export function feedRoutes(db: Db) {
  return createWebRouter().openapi(getFeed, (c) =>
    c.json(feedPage(db, c.var.member, c.req.valid("query")), 200),
  );
}
