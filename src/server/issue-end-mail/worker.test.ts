import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type MailMessage, MailRefused } from "../auth/mail.js";
import { actor, issue, issueEndMail, product } from "../db/schema.js";
import { createEventBus } from "../events/bus.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp, TEST_ORIGIN, testAuthConfig } from "../test-app.js";
import { deriveUnsubscribeKey, unsubscribeUrl } from "./unsubscribe.js";
import {
  createIssueEndMailWorker,
  type IssueEndMailWorkerOptions,
  MAX_ATTEMPTS,
} from "./worker.js";

const {
  app,
  db,
  bus,
  bot,
  request,
  inviteEmail,
  signInWithEmail,
  addMember,
  signIn,
  owner,
} = setupTestApp();

const PERSON = "nia.notify@example.com";
inviteEmail(PERSON);
await signInWithEmail(PERSON);
const person = db.select().from(actor).where(eq(actor.email, PERSON)).get();
if (!person) throw new Error("no person");
const handled = createBot(db, "worker handled");
setBotHandler(db, handled.actor.id, PERSON);

async function api(method: string, path: string, key: string, json?: object) {
  const res = await request(method, `/api/v1${path}`, { key, json });
  const body = await res.json();
  expect(res.status, `${method} ${path}: ${JSON.stringify(body)}`).toBeLessThan(
    300,
  );
  // biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
  return body as any;
}

await api("POST", "/products", bot.key, { key: "WRK", name: "worker" });

/** Files an issue for the person and ends it as the owner; returns its key. */
async function ended(
  status: "done" | "canceled" = "done",
  title = "for nia",
): Promise<string> {
  const filed = await api("POST", "/items", handled.key, {
    type: "issue",
    product: "WRK",
    title,
    filed_for: "handler",
  });
  await api("PATCH", `/items/${filed.key}`, bot.key, { status });
  return filed.key;
}

function rowOf(key: string) {
  const number = Number(key.split("-")[1]);
  const rows = db
    .select({ mail: issueEndMail })
    .from(issueEndMail)
    .innerJoin(issue, eq(issue.id, issueEndMail.issueId))
    .where(eq(issue.number, number))
    .all();
  expect(rows).toHaveLength(1);
  return rows[0]?.mail as typeof issueEndMail.$inferSelect;
}

const unsubscribeKey = deriveUnsubscribeKey(testAuthConfig.BETTER_AUTH_SECRET);
const FROM = "trail <trail@mail.example.test>";

const made: ReturnType<typeof createIssueEndMailWorker>[] = [];

function worker(
  transport: (m: MailMessage, signal?: AbortSignal) => Promise<void>,
  options: Partial<IssueEndMailWorkerOptions> = {},
) {
  const w = createIssueEndMailWorker({
    db,
    bus,
    mail: { from: FROM, publicUrl: TEST_ORIGIN, unsubscribeKey, transport },
    ...options,
  });
  made.push(w);
  return w;
}

// one database per file and tick() sends every due row: whatever a test leaves
// behind (a started worker, fake timers, an unsubscribed person, a pending row)
// is undone here, so a failure cannot fail the next test for another reason
afterEach(async () => {
  vi.restoreAllMocks();
  const stopping = Promise.all(made.splice(0).map((w) => w.stop()));
  // stop() cleared the intervals; what is left is the drain's own setImmediate
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await stopping;
  vi.useRealTimers();
  db.update(actor)
    .set({ issueEndMailOff: false })
    .where(eq(actor.id, person.id))
    .run();
  db.update(issueEndMail)
    .set({ state: "failed" })
    .where(sql`${issueEndMail.state} = 'pending'`)
    .run();
});

test("an ended issue's email goes to the person's address once, with the issue, the owner bot's last comment at ending, the links and the unsubscribe headers", async () => {
  const filed = await api("POST", "/items", handled.key, {
    type: "issue",
    product: "WRK",
    title: "Export drops the last row",
    filed_for: "handler",
  });
  await api("POST", `/items/${filed.key}/comments`, bot.key, {
    body: "Fixed: the CSV writer flushes the last row.",
  });
  await api("PATCH", `/items/${filed.key}`, bot.key, { status: "done" });
  await api("POST", `/items/${filed.key}/comments`, bot.key, {
    body: "A later afterthought.",
  });
  const sent: MailMessage[] = [];
  const w = worker(async (m) => {
    sent.push(m);
  });
  await w.tick();
  await w.tick();
  expect(sent).toHaveLength(1);
  const [message] = sent as [MailMessage];
  expect(message).toMatchObject({
    from: FROM,
    to: PERSON,
    subject: `${filed.key} is done: Export drops the last row`,
    idempotencyKey: `issue-end-mail/${rowOf(filed.key).id}`,
  });
  expect(message.text).toContain("tester wrote:");
  expect(message.text).toContain("Fixed: the CSV writer flushes the last row.");
  expect(message.text).not.toContain("afterthought");
  expect(message.text).toContain(`${TEST_ORIGIN}/issues/${filed.key}\n`);
  const unsubscribe = /\n(http\S+unsubscribe\S+)\n$/.exec(message.text)?.[1];
  expect(message.headers).toEqual({
    "List-Unsubscribe": `<${unsubscribe}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
  expect((await app.request(unsubscribe ?? "")).status).toBe(200);
  expect(rowOf(filed.key)).toMatchObject({
    state: "sent",
    attempts: 1,
    lastError: null,
    sentAt: expect.any(Date),
  });
});

test("an email still pending when the person unsubscribes is skipped, not sent", async () => {
  const key = await ended("canceled");
  const link = new URL(unsubscribeUrl(TEST_ORIGIN, unsubscribeKey, person.id));
  const off = await app.request(`${link.pathname}${link.search}`, {
    method: "POST",
  });
  expect(off.status).toBe(200);
  const sent: MailMessage[] = [];
  await worker(async (m) => {
    sent.push(m);
  }).tick();
  expect(sent).toEqual([]);
  expect(rowOf(key)).toMatchObject({
    state: "skipped",
    lastError: "not sent: the person turned these emails off",
  });
});

test("a person with no email address, signed in with GitHub, is skipped with the reason", async () => {
  const wrk = db.select().from(product).where(eq(product.key, "WRK")).get();
  const cookie = await addMember("gil-github", [wrk?.id ?? ""]);
  const res = await request("POST", "/api/web/issues", {
    key: null,
    cookie,
    json: { product: "WRK", title: "from github" },
  });
  const { key } = (await res.json()) as { key: string };
  await api("PATCH", `/items/${key}`, bot.key, { status: "done" });
  const sent: MailMessage[] = [];
  await worker(async (m) => {
    sent.push(m);
  }).tick();
  expect(sent).toEqual([]);
  expect(rowOf(key)).toMatchObject({
    state: "skipped",
    lastError:
      "not sent: the person has no email address; only a person let in by email has one",
  });
});

test("with no mail provider every email is skipped, naming what is missing, with one warning per worker", async () => {
  const keys = [await ended(), await ended(), await ended("canceled")];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = createIssueEndMailWorker({
    db,
    bus,
    mail: { missing: ["EMAIL_FROM", "RESEND_API_KEY"] },
  });
  await w.tick();
  keys.push(await ended());
  await w.tick();
  for (const key of keys) {
    expect(rowOf(key)).toMatchObject({
      state: "skipped",
      lastError:
        "not sent: email is off until EMAIL_FROM and RESEND_API_KEY is set",
    });
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toMatch(/EMAIL_FROM and RESEND_API_KEY/);
});

test("a dropped connection is retried after the backoff, then sent once", async () => {
  const key = await ended();
  let now = Date.now();
  let calls = 0;
  const w = worker(
    async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
    },
    { now: () => now, backoffMs: [60_000] },
  );
  await w.tick();
  expect(rowOf(key)).toMatchObject({
    state: "pending",
    attempts: 1,
    lastError: "fetch failed",
  });
  await w.tick();
  expect(calls).toBe(1);
  now += 60_000;
  await w.tick();
  await w.tick();
  expect(calls).toBe(2);
  expect(rowOf(key)).toMatchObject({ state: "sent", attempts: 2 });
});

test("a 5xx or 429 is retried up to the attempt cap, then failed", async () => {
  const key = await ended();
  let now = Date.now();
  const statuses = [503, 429];
  const w = worker(
    async () => {
      throw new MailRefused(statuses.shift() ?? 500, "busy");
    },
    { now: () => now, backoffMs: [1_000], maxAttempts: 2 },
  );
  await w.tick();
  expect(rowOf(key)).toMatchObject({ state: "pending", attempts: 1 });
  now += 1_000;
  await w.tick();
  expect(rowOf(key)).toMatchObject({
    state: "failed",
    attempts: 2,
    lastError: "Resend answered 429: busy",
  });
});

test("another 4xx fails the email at once", async () => {
  const key = await ended();
  let calls = 0;
  await worker(async () => {
    calls++;
    throw new MailRefused(422, "invalid to");
  }).tick();
  expect(calls).toBe(1);
  expect(rowOf(key)).toMatchObject({
    state: "failed",
    attempts: 1,
    lastError: "Resend answered 422: invalid to",
  });
});

test("a broken mail side never touches a write: the ending commits and the worker's pass resolves", async () => {
  const w = worker(() => {
    throw new Error("transport exploded");
  });
  const key = await ended();
  await expect(w.tick()).resolves.toBeUndefined();
  const read = await api("GET", `/items/${key}`, bot.key);
  expect(read.status).toBe("done");
  expect(rowOf(key)).toMatchObject({ state: "pending", attempts: 1 });
});

test("stop cuts a send in flight and leaves its email pending for the next start", async () => {
  const key = await ended();
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  const w = worker(
    (_, signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const pass = w.tick();
  await inFlight;
  await w.stop();
  await pass;
  expect(rowOf(key)).toMatchObject({ state: "pending", attempts: 0 });
  const sent: MailMessage[] = [];
  await worker(async (m) => {
    sent.push(m);
  }).tick();
  expect(sent).toHaveLength(1);
});

test("purge deletes finished emails past the keep time and keeps pending ones", async () => {
  const finished = rowOf(await ended());
  const pending = rowOf(await ended());
  db.update(issueEndMail)
    .set({ state: "sent", sentAt: new Date(), createdAt: new Date(0) })
    .where(eq(issueEndMail.id, finished.id))
    .run();
  db.update(issueEndMail)
    .set({ createdAt: new Date(0) })
    .where(eq(issueEndMail.id, pending.id))
    .run();
  await worker(async () => {}, { keepMs: 1_000 }).purge();
  const left = db
    .select({ id: issueEndMail.id })
    .from(issueEndMail)
    .where(inArray(issueEndMail.id, [finished.id, pending.id]))
    .all();
  expect(left).toEqual([{ id: pending.id }]);
});

test("with the real backoff each retry waits longer, the last wait repeats, and the email fails after the last attempt", async () => {
  const key = await ended();
  let now = Date.now();
  let calls = 0;
  const w = worker(
    async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
    { now: () => now, maxAttempts: 8 },
  );
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const waits = [
    MIN,
    5 * MIN,
    30 * MIN,
    2 * HOUR,
    6 * HOUR,
    6 * HOUR,
    6 * HOUR,
  ];
  for (const [i, wait] of waits.entries()) {
    await w.tick();
    const row = rowOf(key);
    expect(row, `after attempt ${i + 1}`).toMatchObject({
      state: "pending",
      attempts: i + 1,
    });
    expect(row.nextAttemptAt.getTime() - now).toBe(wait);
    // one millisecond short of due: no new attempt
    now += wait - 1;
    await w.tick();
    expect(calls).toBe(i + 1);
    now += 1;
  }
  await w.tick();
  expect(calls).toBe(8);
  expect(rowOf(key)).toMatchObject({
    state: "failed",
    attempts: 8,
    lastError: "fetch failed",
  });
});

test("a network error that never clears fails the email after the default attempt cap", async () => {
  const key = await ended();
  let now = Date.now();
  let calls = 0;
  const w = worker(
    async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
    { now: () => now },
  );
  for (let i = 0; i < 10; i++) {
    await w.tick();
    now += 6 * 60 * 60_000;
  }
  expect(MAX_ATTEMPTS).toBe(6);
  expect(calls).toBe(6);
  expect(rowOf(key)).toMatchObject({ state: "failed", attempts: 6 });
});

test("a 409, Resend's idempotency key still in use, is retried and then sent", async () => {
  const key = await ended();
  let now = Date.now();
  let calls = 0;
  const w = worker(
    async () => {
      calls++;
      if (calls === 1) throw new MailRefused(409, "key in use");
    },
    { now: () => now, backoffMs: [1_000] },
  );
  await w.tick();
  expect(rowOf(key)).toMatchObject({
    state: "pending",
    attempts: 1,
    lastError: "Resend answered 409: key in use",
  });
  now += 1_000;
  await w.tick();
  expect(calls).toBe(2);
  expect(rowOf(key)).toMatchObject({ state: "sent", attempts: 2 });
});

test("purge keeps a finished email younger than the keep time and removes older ones in any finished state, never a pending one", async () => {
  const NOW = 10_000;
  const rows = {
    oldSent: rowOf(await ended()),
    oldSkipped: rowOf(await ended()),
    oldFailed: rowOf(await ended()),
    youngSent: rowOf(await ended()),
    oldPending: rowOf(await ended()),
  };
  const set = (
    row: { id: string },
    state: "sent" | "skipped" | "failed" | "pending",
    createdAt: number,
  ) =>
    db
      .update(issueEndMail)
      .set({
        state,
        createdAt: new Date(createdAt),
        // the table requires a send time for sent rows, and only for them
        sentAt: state === "sent" ? new Date(createdAt) : null,
      })
      .where(eq(issueEndMail.id, row.id))
      .run();
  set(rows.oldSent, "sent", 0);
  set(rows.oldSkipped, "skipped", 0);
  set(rows.oldFailed, "failed", 0);
  set(rows.youngSent, "sent", NOW - 500);
  set(rows.oldPending, "pending", 0);
  await worker(async () => {}, { keepMs: 1_000, now: () => NOW }).purge();
  const left = db
    .select({ id: issueEndMail.id })
    .from(issueEndMail)
    .where(
      inArray(
        issueEndMail.id,
        Object.values(rows).map((r) => r.id),
      ),
    )
    .all()
    .map((r) => r.id)
    .sort();
  expect(left).toEqual([rows.youngSent.id, rows.oldPending.id].sort());
});

describe("start", () => {
  // only the clock-driven pieces: the database and the app need the real event loop
  const fakeTimers = () =>
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
      ],
    });
  const collect = () => {
    const sent: MailMessage[] = [];
    return {
      sent,
      transport: async (m: MailMessage) => {
        sent.push(m);
      },
    };
  };
  const never = 1_000_000_000;

  test("an issue ended after start is sent by the bus wake, with no tick and no poll", async () => {
    fakeTimers();
    const { sent, transport } = collect();
    const w = worker(transport, { pollMs: never, purgeMs: never });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    const key = await ended();
    // the wake runs after the publisher's turn, not inside it
    expect(sent).toEqual([]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.subject).toContain(key);
  });

  test("only an issue.updated event wakes the worker", async () => {
    fakeTimers();
    const isolated = createEventBus();
    const w = worker(collect().transport, {
      bus: isolated,
      pollMs: never,
      purgeMs: never,
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    const idle = vi.getTimerCount();
    isolated.publish({ action: "comment.created" } as never);
    expect(vi.getTimerCount()).toBe(idle);
    isolated.publish({ action: "issue.updated" } as never);
    expect(vi.getTimerCount()).toBe(idle + 1);
  });

  test("the poll interval sends a row that came due while the bus was silent", async () => {
    fakeTimers();
    const { sent, transport } = collect();
    // the worker listens to a bus nothing publishes on: only the poll can find the row
    const w = worker(transport, { bus: createEventBus(), pollMs: 5_000 });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    await ended();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
  });

  test("the first pass sends what an earlier run left pending", async () => {
    fakeTimers();
    const { sent, transport } = collect();
    await ended();
    const w = worker(transport, {
      bus: createEventBus(),
      pollMs: never,
      purgeMs: never,
    });
    w.start();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  test("stop ends the poll, the purge and the bus wake", async () => {
    fakeTimers();
    const { sent, transport } = collect();
    const w = worker(transport, { pollMs: 5_000, purgeMs: 5_000 });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    await w.stop();
    expect(vi.getTimerCount()).toBe(0);
    await ended();
    // a live bus subscription would have queued its wake
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });
});

test("a pending email to a person removed from trail is skipped with the reason, while a member's still goes", async () => {
  const REMOVED = "rex.removed@example.com";
  inviteEmail(REMOVED);
  await signInWithEmail(REMOVED);
  const removedBot = createBot(db, "worker removed handler");
  setBotHandler(db, removedBot.actor.id, REMOVED);
  const filed = await api("POST", "/items", removedBot.key, {
    type: "issue",
    product: "WRK",
    title: "for rex",
    filed_for: "handler",
  });
  await api("PATCH", `/items/${filed.key}`, bot.key, { status: "done" });
  const kept = await ended("done", "for nia, still a member");
  const removal = await request("DELETE", `/api/web/people/${REMOVED}`, {
    key: null,
    cookie: await signIn(owner),
  });
  expect(removal.status).toBe(204);

  const sent: MailMessage[] = [];
  await worker(async (m) => {
    sent.push(m);
  }).tick();
  expect(sent.map((m) => m.to)).toEqual([PERSON]);
  expect(rowOf(kept)).toMatchObject({ state: "sent" });
  expect(rowOf(filed.key)).toMatchObject({
    state: "skipped",
    attempts: 0,
    lastError: "not sent: the person no longer has access to trail",
  });
});
