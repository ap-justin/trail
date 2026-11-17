import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, max } from "drizzle-orm";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { errorSchema, eventsQuerySchema } from "../../shared/schemas.js";
import { errorResponse } from "../api/errors.js";
import { jsonContent } from "../api/routes.js";
import type { TrailAuth } from "../auth/auth.js";
import { inviteOf } from "../auth/identity.js";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  actor,
  invite,
  productMember,
  projectProduct,
} from "../db/schema.js";
import type { ActivityEvent, ActorUpdate, EventBus } from "../events/bus.js";
import type { FeedFilters } from "../service/paging.js";
import { entriesByEvent, productRefs } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import { eventsAfter, feedFilters, ofItemType } from "./feed.js";
import { visibleIds } from "./visible.js";

// under the idle timeout of Fly's proxy, which drops a stream that sends nothing
const HEARTBEAT_MS = 15_000;
// a resume further back than this is told to refetch /feed instead
const REPLAY_MAX = 500;
// events queued for a client that isn't reading; past this it is told to refetch, and dropped
const QUEUE_MAX = 1000;
/** Per-person caps on open streams, by kind, each counted apart. */
const STREAMS_PER_PERSON = {
  // a few feed pages plus a reconnect's overlap: each stream projects every event
  // through the one SQLite connection, and re-checks its session
  feed: 5,
  // one per open tab: an actors-only stream queries nothing per event, only its
  // session re-check every HEARTBEAT_MS, so 20 tabs cost one read a person per 0.75 s
  actors: 20,
} as const;

type StreamKind = keyof typeof STREAMS_PER_PERSON;

/**
 * The event streams open in this process: per person, at most
 * STREAMS_PER_PERSON of each kind; all ended by `end()`.
 */
export class LiveStreams {
  readonly #ending = new AbortController();
  readonly #open = new Map<string, number>();
  readonly #running = new Set<Promise<void>>();

  /** Aborted by `end()`; a stream stops at its next turn. */
  get ending(): AbortSignal {
    return this.#ending.signal;
  }

  /**
   * One more stream of the kind for the actor, or undefined at their cap: the
   * returned function runs the stream's body and frees the slot when it settles.
   */
  admit(actorId: string, kind: StreamKind) {
    const slot = `${kind}:${actorId}`;
    const open = this.#open.get(slot) ?? 0;
    if (open >= STREAMS_PER_PERSON[kind]) return undefined;
    this.#open.set(slot, open + 1);
    return async (body: () => Promise<void>) => {
      const running = body();
      this.#running.add(running);
      try {
        await running;
      } finally {
        this.#running.delete(running);
        const left = (this.#open.get(slot) ?? 1) - 1;
        if (left === 0) this.#open.delete(slot);
        else this.#open.set(slot, left);
      }
    };
  }

  /** Ends every stream; resolves once each has stopped, and with it its queries. */
  async end() {
    this.#ending.abort();
    await Promise.allSettled(this.#running);
  }
}

const streamEvents = createRoute({
  method: "get",
  path: "/events",
  request: {
    query: eventsQuerySchema,
    headers: z.object({ "last-event-id": z.string().optional() }),
  },
  responses: {
    200: {
      content: { "text/event-stream": { schema: z.string() } },
      description:
        "Feed entries as they happen, each event's seq its id; Last-Event-ID resumes after that seq. A `reset` event means the client is too far behind: refetch /feed. An `actor` event, `{actorId, photoUrl, title}` with no id, says an actor's photo or a bot's title was set, replaced or removed, and carries both as they are now (each null when unset; title always null on a person), so the latest event for an actor is its whole state: sent whatever the stream's filters, but only to a viewer who can see that actor (the person who runs this trail sees all; a member sees themselves, bots acting in their products and people who share a product with them), and it is not a feed entry, so Last-Event-ID never replays it. A `work` event, `{productKey}` with no id, says an item in that product was created or changed status or assignee, or the product was imported: sent for those the stream's filters keep out (one per product per batch), only for a product the viewer sees, so a client can re-read that product's work in progress; it is never replayed. With only=actors the stream carries `actor` events and heartbeats alone.",
    },
    404: jsonContent(errorSchema, "No such product or project to filter by"),
    429: jsonContent(
      errorSchema,
      `The person already has ${STREAMS_PER_PERSON.feed} streams open, or ${STREAMS_PER_PERSON.actors} with only=actors, which are counted apart: close one first`,
    ),
  },
});

/** A seq from Last-Event-ID; anything else starts the stream live. */
function resumeSeq(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d{1,15}$/.test(header)) return undefined;
  return Number(header);
}

/**
 * The ids of the products the member sees now, or "all" for the owner: read at
 * each batch of events, so a product taken away stops at once.
 */
function productsNow(db: Db, member: Member): Set<string> | "all" {
  if (member.kind === "owner") return "all";
  const rows = db
    .select({ productId: productMember.productId })
    .from(productMember)
    .innerJoin(invite, eq(invite.id, productMember.inviteId))
    .where(inviteOf(member.actor))
    .all();
  return new Set(rows.map((r) => r.productId));
}

/**
 * Whether a viewer of `visible` products may see the event: one of a visible
 * product, or a project's own (no product) when the project draws from one.
 */
function mayShow(
  db: Db,
  event: ActivityEvent,
  visible: Set<string> | "all",
): boolean {
  if (event.productId !== null) {
    return visible === "all" || visible.has(event.productId);
  }
  if (event.projectId === null) return false;
  if (visible === "all") return true;
  if (visible.size === 0) return false;
  return (
    db
      .select({ one: projectProduct.projectId })
      .from(projectProduct)
      .where(
        and(
          eq(projectProduct.projectId, event.projectId),
          inArray(projectProduct.productId, [...visible]),
        ),
      )
      .limit(1)
      .all().length > 0
  );
}

/**
 * Whether the member may hear of this actor's photo or title changing: the owner hears of
 * everyone; a member of themselves, of a bot acting in one of their products
 * (`botsActingIn`'s rule in feed.ts) and of a person who shares a product with
 * them, the owner being in every product. Read at each delivery, so a product
 * taken away stops it at once.
 */
function mayHearOf(db: Db, member: Member, actorId: string): boolean {
  const visible = productsNow(db, member);
  if (visible === "all" || actorId === member.actor.id) return true;
  if (visible.size === 0) return false;
  const row = db.select().from(actor).where(eq(actor.id, actorId)).get();
  if (!row) return false;
  if (row.kind === "bot") {
    return (
      db
        .select({ one: activityEvent.id })
        .from(activityEvent)
        .where(
          and(
            eq(activityEvent.actorId, actorId),
            inArray(activityEvent.productId, [...visible]),
          ),
        )
        .limit(1)
        .all().length > 0
    );
  }
  if (row.isOwner) return true;
  const theirs = db
    .select({ productId: productMember.productId })
    .from(productMember)
    .innerJoin(invite, eq(invite.id, productMember.inviteId))
    .where(
      row.githubId === null
        ? eq(invite.email, row.email ?? "")
        : eq(invite.githubId, row.githubId),
    )
    .all();
  return theirs.some((r) => visible.has(r.productId));
}

const matches = (filters: FeedFilters, event: ActivityEvent) =>
  (filters.projectId === null || event.productId === filters.projectId) &&
  (filters.groupId == null || event.projectId === filters.groupId) &&
  (filters.actorId === null || event.actorId === filters.actorId);

/** Those of `events` the type filter keeps, read in one query: the item's type is the row's now. */
function ofType(
  db: Db,
  filters: FeedFilters,
  events: ActivityEvent[],
): ActivityEvent[] {
  if (filters.type == null || events.length === 0) return events;
  const kept = new Set(
    db
      .select({ id: activityEvent.id })
      .from(activityEvent)
      .where(
        and(
          inArray(
            activityEvent.id,
            events.map((e) => e.id),
          ),
          ofItemType(filters.type),
        ),
      )
      .all()
      .map((e) => e.id),
  );
  return events.filter((e) => kept.has(e.id));
}

/**
 * Whether the event becomes an entry that can move an item into or out of a
 * bot's work: `item_created`, `status_changed`, `assignee_changed` or
 * `product_imported` (the kinds `movesBotWork` in src/web/lib/use-live-feed.ts re-reads on).
 */
function movesWork(event: ActivityEvent): boolean {
  if (event.action === "issue.created" || event.action === "product.imported")
    return true;
  if (event.action !== "issue.updated") return false;
  const changes = event.payload as Record<string, unknown> | null;
  return changes?.status != null || changes?.assigneeId != null;
}

/** The distinct product ids, in order, of the events that move work. */
const productsMovingWork = (events: ActivityEvent[]) => [
  ...new Set(
    events.flatMap((e) =>
      e.productId !== null && movesWork(e) ? [e.productId] : [],
    ),
  ),
];

const newestSeq = (db: Db) =>
  db
    .select({ seq: max(activityEvent.seq) })
    .from(activityEvent)
    .get()?.seq ?? 0;

export function eventRoutes(
  db: Db,
  bus: EventBus,
  auth: TrailAuth,
  streams: LiveStreams,
) {
  return createWebRouter().openapi(streamEvents, (c) => {
    const member = c.var.member;
    const query = c.req.valid("query");
    const kind: StreamKind = query.only === "actors" ? "actors" : "feed";
    // resolved before the stream opens, so a product or project the member can't see is the feed's 404
    const filters = feedFilters(db, member, query);
    // actor events are never replayed, so an actors-only stream has nothing to resume
    const resumeFrom =
      kind === "feed"
        ? resumeSeq(c.req.valid("header")["last-event-id"])
        : undefined;
    const headers = c.req.raw.headers;
    const shutdown = streams.ending;

    /** Whether the session still resolves to this member: signed out or uninvited ends the stream. */
    async function stillLetIn() {
      const viewer = await auth.resolveViewer(headers);
      return (
        (viewer.kind === "member" || viewer.kind === "owner") &&
        viewer.actor.id === member.actor.id
      );
    }

    const live = async (stream: SSEStreamingApi) => {
      const pending: ActivityEvent[] = [];
      let overflowed = false;
      let queuedSeq = 0;
      let wake = () => {};
      const onEvent = (event: ActivityEvent) => {
        if (overflowed) return;
        queuedSeq = Math.max(queuedSeq, event.seq);
        if (pending.length >= QUEUE_MAX) {
          overflowed = true;
          pending.length = 0;
        } else {
          pending.push(event);
        }
        wake();
      };
      // an actors-only stream never hears feed events, so never projects one
      const unsubscribe = kind === "feed" ? bus.subscribe(onEvent) : () => {};
      // keyed by actor and last-wins, so it stays one entry per actor however
      // far the client falls behind
      const actorUpdates = new Map<string, ActorUpdate>();
      const unsubscribeActors = bus.subscribeActors((update) => {
        actorUpdates.set(update.actorId, update);
        wake();
      });
      let ended = false;
      const end = () => {
        ended = true;
        wake();
      };
      stream.onAbort(end);
      shutdown.addEventListener("abort", end);
      // armed once per check, never by an event, so bus traffic can't postpone it
      let checkDue = false;
      let checkTimer: ReturnType<typeof setTimeout> | undefined;
      const armCheck = () => {
        checkTimer = setTimeout(() => {
          checkDue = true;
          wake();
        }, HEARTBEAT_MS);
      };
      armCheck();
      const reset = (seq: number) =>
        stream.writeSSE({
          event: "reset",
          id: String(seq),
          data: JSON.stringify({ reason: "too_far_behind" }),
        });
      try {
        if (shutdown.aborted) return;
        await stream.write(": connected\n\n");
        let lastSeq = 0;
        const send = async (events: ActivityEvent[]) => {
          const fresh = events.filter((e) => e.seq > lastSeq);
          if (fresh.length === 0) return;
          lastSeq = Math.max(...fresh.map((e) => e.seq));
          const visible = productsNow(db, member);
          // a work-moving event has a product, so its mayShow reads nothing
          const seen = fresh.filter(
            (e) =>
              (matches(filters, e) || movesWork(e)) && mayShow(db, e, visible),
          );
          const shown = ofType(
            db,
            filters,
            seen.filter((e) => matches(filters, e)),
          );
          for (const [i, entries] of entriesByEvent(db, shown).entries()) {
            for (const entry of entries) {
              await stream.writeSSE({
                id: String(shown[i]?.seq),
                data: JSON.stringify(entry),
              });
            }
          }
          // the shown ones already reached the client as entries
          const sent = new Set(shown);
          const workIn = productsMovingWork(seen.filter((e) => !sent.has(e)));
          if (workIn.length === 0) return;
          const productOf = productRefs(db, workIn);
          // without an id: not a feed entry, so Last-Event-ID stays the entries'
          for (const productId of workIn) {
            await stream.writeSSE({
              event: "work",
              data: JSON.stringify({ productKey: productOf(productId).key }),
            });
          }
        };
        if (resumeFrom !== undefined) {
          const missed = eventsAfter(
            db,
            visibleIds(member),
            filters,
            resumeFrom,
            REPLAY_MAX + 1,
          );
          if (missed.length > REPLAY_MAX) {
            lastSeq = newestSeq(db);
            await reset(lastSeq);
          } else {
            lastSeq = resumeFrom;
            await send(missed);
          }
        }
        while (!ended) {
          if (overflowed) {
            await reset(Math.max(newestSeq(db), queuedSeq));
            return;
          }
          if (checkDue) {
            checkDue = false;
            if (!(await stillLetIn()) || ended) return;
            await stream.write(": heartbeat\n\n");
            armCheck();
            continue;
          }
          if (pending.length > 0) {
            await send(pending.splice(0));
            continue;
          }
          if (actorUpdates.size > 0) {
            const updates = [...actorUpdates.values()];
            actorUpdates.clear();
            // without an id: not a feed entry, so Last-Event-ID stays the entries'
            for (const { actorId, photoUrl, title } of updates) {
              if (!mayHearOf(db, member, actorId)) continue;
              await stream.writeSSE({
                event: "actor",
                data: JSON.stringify({ actorId, photoUrl, title }),
              });
            }
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = () => {};
        }
      } finally {
        clearTimeout(checkTimer);
        unsubscribe();
        unsubscribeActors();
        shutdown.removeEventListener("abort", end);
      }
    };

    const run = streams.admit(member.actor.id, kind);
    if (run === undefined) {
      const which = kind === "feed" ? "live" : "actors-only";
      return errorResponse(
        c,
        429,
        "too_many_streams",
        `at most ${STREAMS_PER_PERSON[kind]} ${which} streams per person: close one first`,
      );
    }
    return streamSSE(c, (stream) => run(() => live(stream)));
  });
}
