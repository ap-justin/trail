import { createRoute, z } from "@hono/zod-openapi";
import { eq, max } from "drizzle-orm";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { errorSchema, eventsQuerySchema } from "../../shared/schemas.js";
import { errorResponse } from "../api/errors.js";
import { jsonContent } from "../api/routes.js";
import type { TrailAuth } from "../auth/auth.js";
import type { Db } from "../db/client.js";
import { activityEvent, invite, projectMember } from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import type { FeedFilters } from "../service/paging.js";
import { entriesByEvent } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import { eventsAfter, feedFilters } from "./feed.js";
import { visibleIds } from "./visible.js";

// under the idle timeout of Fly's proxy, which drops a stream that sends nothing
const HEARTBEAT_MS = 15_000;
// a resume further back than this is told to refetch /feed instead
const REPLAY_MAX = 500;
// events queued for a client that isn't reading; past this it is told to refetch, and dropped
const QUEUE_MAX = 1000;
// a few tabs plus a reconnect's overlap: each stream queries and re-checks its session
// on the one SQLite connection
const STREAMS_PER_PERSON = 5;

/**
 * The event streams open in this process: at most STREAMS_PER_PERSON per
 * person, all ended by `end()`.
 */
export class LiveStreams {
  readonly #ending = new AbortController();
  readonly #perActor = new Map<string, number>();
  readonly #running = new Set<Promise<void>>();

  /** Aborted by `end()`; a stream stops at its next turn. */
  get ending(): AbortSignal {
    return this.#ending.signal;
  }

  /**
   * One more stream for the actor, or undefined at their cap: the returned
   * function runs the stream's body and frees the slot when it settles.
   */
  admit(actorId: string) {
    const open = this.#perActor.get(actorId) ?? 0;
    if (open >= STREAMS_PER_PERSON) return undefined;
    this.#perActor.set(actorId, open + 1);
    return async (body: () => Promise<void>) => {
      const running = body();
      this.#running.add(running);
      try {
        await running;
      } finally {
        this.#running.delete(running);
        const left = (this.#perActor.get(actorId) ?? 1) - 1;
        if (left === 0) this.#perActor.delete(actorId);
        else this.#perActor.set(actorId, left);
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
        "Feed entries as they happen, each event's seq its id; Last-Event-ID resumes after that seq. A `reset` event means the client is too far behind: refetch /feed.",
    },
    404: jsonContent(errorSchema, "No such project to filter by"),
    429: jsonContent(
      errorSchema,
      `The person already has ${STREAMS_PER_PERSON} streams open: close one first`,
    ),
  },
});

/** A seq from Last-Event-ID; anything else starts the stream live. */
function resumeSeq(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d{1,15}$/.test(header)) return undefined;
  return Number(header);
}

/**
 * The ids of the projects the member sees now, or "all" for the owner: read at
 * each batch of events, so a project taken away stops at once.
 */
function projectsNow(db: Db, member: Member): Set<string> | "all" {
  if (member.kind === "owner") return "all";
  const rows = db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .innerJoin(invite, eq(invite.username, projectMember.username))
    // the invite the account claimed, whatever its login is now
    .where(eq(invite.githubId, member.actor.githubId))
    .all();
  return new Set(rows.map((r) => r.projectId));
}

const matches = (filters: FeedFilters, event: ActivityEvent) =>
  (filters.projectId === null || event.projectId === filters.projectId) &&
  (filters.actorId === null || event.actorId === filters.actorId);

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
    // resolved before the stream opens, so a project the member can't see is the feed's 404
    const filters = feedFilters(member, c.req.valid("query"));
    const resumeFrom = resumeSeq(c.req.valid("header")["last-event-id"]);
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
      const unsubscribe = bus.subscribe((event) => {
        if (overflowed) return;
        queuedSeq = Math.max(queuedSeq, event.seq);
        if (pending.length >= QUEUE_MAX) {
          overflowed = true;
          pending.length = 0;
        } else {
          pending.push(event);
        }
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
          const visible = projectsNow(db, member);
          const shown = fresh.filter(
            (e) =>
              e.projectId !== null &&
              matches(filters, e) &&
              (visible === "all" || visible.has(e.projectId)),
          );
          for (const [i, entries] of entriesByEvent(db, shown).entries()) {
            for (const entry of entries) {
              await stream.writeSSE({
                id: String(shown[i]?.seq),
                data: JSON.stringify(entry),
              });
            }
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
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = () => {};
        }
      } finally {
        clearTimeout(checkTimer);
        unsubscribe();
        shutdown.removeEventListener("abort", end);
      }
    };

    const run = streams.admit(member.actor.id);
    if (run === undefined) {
      return errorResponse(
        c,
        429,
        "too_many_streams",
        `at most ${STREAMS_PER_PERSON} live streams per person: close one first`,
      );
    }
    return streamSSE(c, (stream) => run(() => live(stream)));
  });
}
