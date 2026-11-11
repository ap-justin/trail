import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { errorSchema, eventsQuerySchema } from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { projectMember } from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import type { FeedFilters } from "../service/paging.js";
import { entriesOf } from "./entries.js";
import { createWebRouter, type Member } from "./env.js";
import { eventsAfter, feedFilters } from "./feed.js";
import { visibleIds } from "./visible.js";

// under the idle timeout of Fly's proxy, which drops a stream that sends nothing
const HEARTBEAT_MS = 15_000;

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
        "Feed entries as they happen, each event's seq its id; Last-Event-ID resumes after that seq",
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
 * Whether the member sees this event now: its projects are read at each event,
 * so a project taken away stops at once.
 */
function visibleNow(db: Db, member: Member, event: ActivityEvent): boolean {
  if (event.projectId === null) return false;
  if (member.kind === "owner") return true;
  return (
    db
      .select({ projectId: projectMember.projectId })
      .from(projectMember)
      .where(
        and(
          eq(projectMember.username, member.login),
          eq(projectMember.projectId, event.projectId),
        ),
      )
      .get() !== undefined
  );
}

const matches = (filters: FeedFilters, event: ActivityEvent) =>
  (filters.projectId === null || event.projectId === filters.projectId) &&
  (filters.actorId === null || event.actorId === filters.actorId);

export function eventRoutes(db: Db, bus: EventBus, shutdown: AbortSignal) {
  return createWebRouter().openapi(streamEvents, (c) => {
    const member = c.var.member;
    // resolved before the stream opens, so a project the member can't see is the feed's 404
    const filters = feedFilters(member, c.req.valid("query"));
    const resumeFrom = resumeSeq(c.req.valid("header")["last-event-id"]);

    return streamSSE(c, async (stream) => {
      const pending: ActivityEvent[] = [];
      let wake = () => {};
      const unsubscribe = bus.subscribe((event) => {
        pending.push(event);
        wake();
      });
      let ended = false;
      const end = () => {
        ended = true;
        wake();
      };
      stream.onAbort(end);
      shutdown.addEventListener("abort", end);
      try {
        if (shutdown.aborted) return;
        await stream.write(": connected\n\n");
        let lastSeq = 0;
        const send = async (events: ActivityEvent[]) => {
          for (const event of events) {
            if (event.seq <= lastSeq) continue;
            lastSeq = event.seq;
            if (!matches(filters, event) || !visibleNow(db, member, event)) {
              continue;
            }
            for (const entry of entriesOf(db, [event])) {
              await stream.writeSSE({
                id: String(event.seq),
                data: JSON.stringify(entry),
              });
            }
          }
        };
        if (resumeFrom !== undefined) {
          lastSeq = resumeFrom;
          await send(eventsAfter(db, visibleIds(member), filters, resumeFrom));
        }
        while (!ended) {
          if (pending.length > 0) {
            await send(pending.splice(0));
            continue;
          }
          const woken = await new Promise<boolean>((resolve) => {
            const idle = setTimeout(() => resolve(false), HEARTBEAT_MS);
            wake = () => {
              clearTimeout(idle);
              resolve(true);
            };
          });
          wake = () => {};
          if (!woken && !ended) await stream.write(": heartbeat\n\n");
        }
      } finally {
        unsubscribe();
        shutdown.removeEventListener("abort", end);
      }
    });
  });
}
