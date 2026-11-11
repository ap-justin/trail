import { createRoute, z } from "@hono/zod-openapi";
import { eq, max } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { errorSchema, eventsQuerySchema } from "../../shared/schemas.js";
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
  shutdown: AbortSignal,
) {
  return createWebRouter().openapi(streamEvents, (c) => {
    const member = c.var.member;
    // resolved before the stream opens, so a project the member can't see is the feed's 404
    const filters = feedFilters(member, c.req.valid("query"));
    const resumeFrom = resumeSeq(c.req.valid("header")["last-event-id"]);
    const headers = c.req.raw.headers;

    /** Whether the session still resolves to this member: signed out or uninvited ends the stream. */
    async function stillLetIn() {
      const viewer = await auth.resolveViewer(headers);
      return (
        (viewer.kind === "member" || viewer.kind === "owner") &&
        viewer.actor.id === member.actor.id
      );
    }

    return streamSSE(c, async (stream) => {
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
            if (!(await stillLetIn())) return;
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
    });
  });
}
