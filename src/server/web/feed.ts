import { createRoute } from "@hono/zod-openapi";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  errorSchema,
  type FeedView,
  feedQuerySchema,
  feedSchema,
  WEB_FEED_PROJECTS_MAX,
} from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { activityEvent, actor, project } from "../db/schema.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedFilters,
  pageLimit,
} from "../service/paging.js";
import { amongVisible } from "../service/visible.js";
import { entriesOf, shownEvent } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import {
  projectIdsAmong,
  selectWebActors,
  toWebActor,
  visibleEvents,
  visibleIds,
  visibleProduct,
  visibleProject,
} from "./visible.js";

const getFeed = createRoute({
  method: "get",
  path: "/feed",
  request: { query: feedQuerySchema },
  responses: {
    200: jsonContent(
      feedSchema,
      "Entries newest first; limit counts events, and an event that changed several fields is several entries",
    ),
    404: jsonContent(errorSchema, "No such product or project to filter by"),
    422: jsonContent(errorSchema, "A cursor issued under other filters"),
  },
});

/** The filters a feed or event stream was asked for, the product and project resolved against the viewer's. */
export function feedFilters(
  db: Db,
  member: Member,
  query: { actor?: string; product?: string; project?: string },
): FeedFilters {
  return {
    projectId:
      query.product === undefined
        ? null
        : visibleProduct(member, query.product).id,
    actorId: query.actor ?? null,
    groupId:
      query.project === undefined
        ? null
        : visibleProject(db, member, query.project).id,
  };
}

/** The events these filters show to a viewer of the products with these ids, the ids checked inside the query. */
export function feedWhere(db: Db, productIds: string[], filters: FeedFilters) {
  return [
    visibleEvents(db, productIds),
    filters.projectId === null
      ? undefined
      : eq(activityEvent.productId, filters.projectId),
    filters.groupId == null
      ? undefined
      : eq(activityEvent.projectId, filters.groupId),
    filters.actorId === null
      ? undefined
      : eq(activityEvent.actorId, filters.actorId),
    shownEvent,
  ];
}

/** Up to `limit` shown events after `seq`, oldest first: what a stream resuming from `seq` missed. */
export function eventsAfter(
  db: Db,
  productIds: string[],
  filters: FeedFilters,
  seq: number,
  limit: number,
) {
  return db
    .select()
    .from(activityEvent)
    .where(
      and(...feedWhere(db, productIds, filters), gt(activityEvent.seq, seq)),
    )
    .orderBy(asc(activityEvent.seq))
    .limit(limit)
    .all();
}

function feedPage(
  db: Db,
  member: Member,
  query: {
    cursor?: string;
    limit?: number;
    actor?: string;
    product?: string;
    project?: string;
  },
): FeedView {
  const limit = pageLimit(query.limit);
  const filters = feedFilters(db, member, query);
  const ids = visibleIds(member);
  const where: (SQL | undefined)[] = feedWhere(db, ids, filters);
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
      products: member.products.map(({ key, name }) => ({ key, name })),
      projects: db
        .select({ slug: project.slug, name: project.name })
        .from(project)
        .where(inArray(project.id, projectIdsAmong(db, ids)))
        .orderBy(asc(project.name), asc(project.slug))
        .limit(WEB_FEED_PROJECTS_MAX)
        .all(),
    },
  };
}

/** The bots with an event in these products, A to Z. */
function botsActingIn(db: Db, productIds: string[]) {
  return selectWebActors(db)
    .where(
      and(
        eq(actor.kind, "bot"),
        // per bot, so the (actor_id, product_id) index answers it without walking the products' history
        exists(
          db
            .select({ one: sql`1` })
            .from(activityEvent)
            .where(
              and(
                eq(activityEvent.actorId, actor.id),
                amongVisible(activityEvent.productId, productIds),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(actor.displayName))
    .all()
    .map(toWebActor);
}

export function feedRoutes(db: Db) {
  return createWebRouter().openapi(getFeed, (c) =>
    c.json(feedPage(db, c.var.member, c.req.valid("query")), 200),
  );
}
