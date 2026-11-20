import { and, desc, eq, sql } from "drizzle-orm";
import {
  type activityEvent,
  actor,
  comment,
  issue,
  issueEndMail,
  product,
} from "../db/schema.js";
import type { Tx } from "../service/tx.js";

const isEnding = (status: unknown): status is "done" | "canceled" =>
  status === "done" || status === "canceled";

/**
 * Queues the email to the person an issue was filed for when `event` ends
 * that issue: its status moved to done or canceled from one that isn't. A
 * plain insert in the event's own transaction; the worker sends it later.
 */
export function enqueueIssueEndMail(
  tx: Tx,
  event: typeof activityEvent.$inferSelect,
  now: number,
) {
  if (event.action !== "issue.updated") return;
  const status = event.payload.status as
    | { from: unknown; to: unknown }
    | undefined;
  if (!status || !isEnding(status.to) || isEnding(status.from)) return;
  const ended = tx
    .select({
      id: issue.id,
      type: issue.type,
      filedForId: issue.filedForId,
      ownerId: product.ownerId,
      off: actor.issueEndMailOff,
    })
    .from(issue)
    .innerJoin(product, eq(product.id, issue.productId))
    .innerJoin(actor, eq(actor.id, issue.filedForId))
    .where(eq(issue.id, event.subjectId))
    .get();
  if (ended?.type !== "issue" || ended.off) return;
  const reason =
    ended.ownerId === null
      ? undefined
      : tx
          .select({ id: comment.id })
          .from(comment)
          .where(
            and(
              eq(comment.issueId, ended.id),
              eq(comment.authorId, ended.ownerId),
            ),
          )
          // rowid: two comments in one millisecond keep their insert order
          .orderBy(desc(comment.createdAt), desc(sql`${comment}.rowid`))
          .limit(1)
          .get();
  tx.insert(issueEndMail)
    .values({
      issueId: ended.id,
      recipientId: ended.filedForId as string,
      eventId: event.id,
      status: status.to,
      commentId: reason?.id ?? null,
      nextAttemptAt: new Date(now),
    })
    .run();
}
