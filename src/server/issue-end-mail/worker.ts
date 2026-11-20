import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  issueEndedEmail,
  MailRefused,
  type MailTransport,
} from "../auth/mail.js";
import type { Db } from "../db/client.js";
import { actor, comment, issue, issueEndMail, product } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import { type UnsubscribeKey, unsubscribeUrl } from "./unsubscribe.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Waits before the 2nd, 3rd, ... attempt; the last repeats. The whole run
 * stays well inside the 24 hours Resend keeps an idempotency key, so a retry
 * after a send whose answer was lost doesn't send twice.
 */
export const BACKOFF_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR];
export const MAX_ATTEMPTS = 6;
export const POLL_MS = 30_000;
/** Sent, skipped and failed emails are kept this long after they were queued. */
export const KEEP_MS = 30 * DAY;
export const PURGE_MS = 10 * MINUTE;
export const PURGE_BATCH = 500;
const DUE_BATCH = 20;

const TURNED_OFF = "not sent: the person turned these emails off";
const NO_ADDRESS =
  "not sent: the person has no email address; only a person let in by email has one";

/** How the emails go out, or the variables they still need. */
export type IssueEndMailSettings =
  | {
      from: string;
      /** the origin the issue and unsubscribe links point at */
      publicUrl: string;
      unsubscribeKey: UnsubscribeKey;
      transport: MailTransport;
    }
  | { missing: string[] };

export type IssueEndMailWorkerOptions = {
  db: Db;
  bus: EventBus;
  mail: IssueEndMailSettings;
  now?: () => number;
  backoffMs?: number[];
  maxAttempts?: number;
  pollMs?: number;
  keepMs?: number;
  purgeMs?: number;
  purgeBatch?: number;
};

type Row = typeof issueEndMail.$inferSelect;

/** Network errors, 5xx, 429 and 409 (Resend's idempotency key still in use) are worth another try. */
const isRetryable = (error: unknown) =>
  !(error instanceof MailRefused) ||
  error.status >= 500 ||
  error.status === 429 ||
  error.status === 409;

/**
 * Sends the issue-ended emails the outbox holds. The rows are written with the
 * ending, so this only has to find them: the bus wakes it, a poll finds
 * retries come due and what a restart left. One pass at a time, an email at a
 * time. At least once: a crash between the provider's answer and the row's
 * update sends again, under the same idempotency key.
 */
export function createIssueEndMailWorker(options: IssueEndMailWorkerOptions) {
  const { db, bus, mail } = options;
  const now = options.now ?? Date.now;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const pollMs = options.pollMs ?? POLL_MS;
  const keepMs = options.keepMs ?? KEEP_MS;
  const purgeMs = options.purgeMs ?? PURGE_MS;
  const batch = options.purgeBatch ?? PURGE_BATCH;

  const abort = new AbortController();
  let pass: Promise<void> | null = null;
  let again = false;
  let warned = false;
  let purging: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let timers: NodeJS.Timeout[] = [];

  function finish(
    row: Row,
    state: "sent" | "skipped" | "failed",
    lastError: string | null,
    attempts = row.attempts,
  ) {
    db.update(issueEndMail)
      .set({
        state,
        lastError,
        attempts,
        sentAt: state === "sent" ? new Date(now()) : null,
      })
      .where(
        and(eq(issueEndMail.id, row.id), eq(issueEndMail.state, "pending")),
      )
      .run();
  }

  function retryOrFail(row: Row, error: unknown) {
    const attempts = row.attempts + 1;
    const lastError = error instanceof Error ? error.message : String(error);
    if (!isRetryable(error) || attempts >= maxAttempts) {
      finish(row, "failed", lastError, attempts);
      return;
    }
    const wait = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 0;
    db.update(issueEndMail)
      .set({ attempts, lastError, nextAttemptAt: new Date(now() + wait) })
      .where(
        and(eq(issueEndMail.id, row.id), eq(issueEndMail.state, "pending")),
      )
      .run();
  }

  /** The email for `row` to `to`, read now: the issue's current title, the comment the ending kept. */
  function messageOf(
    row: Row,
    to: string,
    settings: Extract<IssueEndMailSettings, { from: string }>,
  ) {
    const ended = db
      .select({ number: issue.number, title: issue.title, key: product.key })
      .from(issue)
      .innerJoin(product, eq(product.id, issue.productId))
      .where(eq(issue.id, row.issueId))
      .get();
    if (!ended) throw new Error(`issue ${row.issueId} is gone`);
    const reason =
      row.commentId === null
        ? undefined
        : db
            .select({ body: comment.body, author: actor.displayName })
            .from(comment)
            .innerJoin(actor, eq(actor.id, comment.authorId))
            .where(eq(comment.id, row.commentId))
            .get();
    const key = `${ended.key}-${ended.number}`;
    const origin = settings.publicUrl.replace(/\/+$/, "");
    const unsubscribe = unsubscribeUrl(
      origin,
      settings.unsubscribeKey,
      row.recipientId,
    );
    return {
      from: settings.from,
      to,
      ...issueEndedEmail({
        key,
        title: ended.title,
        status: row.status,
        comment: reason ?? null,
        url: `${origin}/issues/${key}`,
        unsubscribeUrl: unsubscribe,
      }),
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      idempotencyKey: `issue-end-mail/${row.id}`,
    };
  }

  async function attempt(row: Row) {
    if ("missing" in mail) {
      const missing = mail.missing.join(" and ");
      if (!warned) {
        warned = true;
        console.warn(`Issue-ended emails are skipped until ${missing} is set`);
      }
      finish(row, "skipped", `not sent: email is off until ${missing} is set`);
      return;
    }
    const recipient = db
      .select({ email: actor.email, off: actor.issueEndMailOff })
      .from(actor)
      .where(eq(actor.id, row.recipientId))
      .get();
    if (recipient?.off) return finish(row, "skipped", TURNED_OFF);
    if (!recipient?.email) return finish(row, "skipped", NO_ADDRESS);
    try {
      await mail.transport(messageOf(row, recipient.email, mail), abort.signal);
    } catch (error) {
      // a shutdown cut the request: the email stays pending for the next start
      if (abort.signal.aborted) return;
      retryOrFail(row, error);
      return;
    }
    finish(row, "sent", null, row.attempts + 1);
  }

  function due(): Row[] {
    return db
      .select()
      .from(issueEndMail)
      .where(
        and(
          // 'pending' as a literal, so the planner can match the partial index
          sql`${issueEndMail.state} = 'pending'`,
          lte(issueEndMail.nextAttemptAt, new Date(now())),
        ),
      )
      .orderBy(asc(issueEndMail.nextAttemptAt))
      .limit(DUE_BATCH)
      .all();
  }

  async function drain() {
    do {
      again = false;
      for (let rows = due(); rows.length > 0; rows = due()) {
        for (const row of rows) {
          if (abort.signal.aborted) return;
          try {
            await attempt(row);
          } catch (error) {
            console.error("issue-ended email crashed", row.id, error);
            try {
              retryOrFail(row, new Error("internal error"));
            } catch {
              // the database refused even that: the next poll tries again
              return;
            }
          }
        }
        // a macrotask turn between batches, so a backlog never starves the event loop
        await new Promise((done) => setImmediate(done));
      }
    } while (again && !abort.signal.aborted);
  }

  /** Sends every due email; a call during a pass makes that pass look again. Never rejects. */
  function tick(): Promise<void> {
    if (pass) {
      again = true;
      return pass;
    }
    if (abort.signal.aborted) return Promise.resolve();
    const current = drain()
      .catch((error) => console.error("issue-ended email pass failed", error))
      .finally(() => {
        pass = null;
      });
    pass = current;
    return current;
  }

  /** Deletes finished emails queued over `keepMs` ago, a batch at a time. Never rejects. */
  function purge(): Promise<void> {
    if (purging) return purging;
    const current = (async () => {
      try {
        while (!abort.signal.aborted) {
          const old = db
            .select({ id: issueEndMail.id })
            .from(issueEndMail)
            .where(
              and(
                // a literal, so the planner matches the partial index
                sql`${issueEndMail.state} <> 'pending'`,
                lt(issueEndMail.createdAt, new Date(now() - keepMs)),
              ),
            )
            .orderBy(asc(issueEndMail.createdAt))
            .limit(batch);
          const removed = db
            .delete(issueEndMail)
            .where(inArray(issueEndMail.id, old))
            .run().changes;
          if (removed < batch) break;
          await new Promise((done) => setImmediate(done));
        }
      } catch (error) {
        console.error("issue-ended email purge failed", error);
      }
    })().finally(() => {
      purging = null;
    });
    purging = current;
    return current;
  }

  return {
    tick,
    purge,
    /** Starts listening to the bus and polling; the first pass sends whatever an earlier run left. */
    start() {
      if (unsubscribe) return;
      // after the publisher's turn, so publishing never runs the worker's queries
      unsubscribe = bus.subscribe((event) => {
        if (event.action === "issue.updated") setImmediate(() => void tick());
      });
      timers = [
        setInterval(() => void tick(), pollMs),
        setInterval(() => void purge(), purgeMs),
      ];
      for (const timer of timers) timer.unref();
      void tick();
      void purge();
    },
    /** Stops sending, cuts a send in flight (its email stays pending) and waits for the pass to end. */
    async stop() {
      unsubscribe?.();
      for (const timer of timers) clearInterval(timer);
      abort.abort();
      await Promise.all([pass, purging]);
    },
  };
}
