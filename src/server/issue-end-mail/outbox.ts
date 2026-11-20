import { and, desc, eq, sql } from "drizzle-orm";
import { accessOf, accessOfEmail, visibleProducts } from "../auth/identity.js";
import type { Db } from "../db/client.js";
import {
  type activityEvent,
  actor,
  comment,
  issue,
  issueEndMail,
  product,
} from "../db/schema.js";
import type { Tx } from "../service/tx.js";

/**
 * Whether the person `actorId` sees `productId` by the rule the product pages
 * apply at sign-in: the owner every product, a member those its invite lists.
 */
export function seesProduct(
  db: Db | Tx,
  actorId: string,
  productId: string,
): boolean {
  const person = db.select().from(actor).where(eq(actor.id, actorId)).get();
  if (!person) return false;
  const access =
    person.githubId !== null
      ? // the login is only shown, never matched
        accessOf(db, person.githubId, person.githubLogin ?? "")
      : person.email !== null
        ? accessOfEmail(db, person.email)
        : null;
  return (
    access !== null &&
    visibleProducts(db, access).some((p) => p.id === productId)
  );
}

const isEnding = (status: unknown): status is "done" | "canceled" =>
  status === "done" || status === "canceled";

/**
 * Queues the email to the person an issue was filed for when `event` ends
 * that issue: its status moved to done or canceled from one that isn't. The
 * email quotes the ender's newest comment, else the product owner's. A
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
      filedForId: issue.filedForId,
      productId: issue.productId,
      ownerId: product.ownerId,
      off: actor.issueEndMailOff,
    })
    .from(issue)
    .innerJoin(product, eq(product.id, issue.productId))
    // whatever its type now: an issue accepted as a todo is still filed for that person
    .innerJoin(actor, eq(actor.id, issue.filedForId))
    .where(eq(issue.id, event.subjectId))
    .get();
  if (!ended || ended.off) return;
  // a link the person would follow to a 404, under a title and comment they may not read
  if (!seesProduct(tx, ended.filedForId as string, ended.productId)) return;
  const newestBy = (authorId: string) =>
    tx
      .select({ id: comment.id })
      .from(comment)
      .where(and(eq(comment.issueId, ended.id), eq(comment.authorId, authorId)))
      // rowid: two comments in one millisecond keep their insert order
      .orderBy(desc(comment.createdAt), desc(sql`${comment}.rowid`))
      .limit(1)
      .get();
  // the ender's own word first: a filer withdrawing its issue says why, not the owner
  const reason =
    newestBy(event.actorId) ??
    (ended.ownerId === null ? undefined : newestBy(ended.ownerId));
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
