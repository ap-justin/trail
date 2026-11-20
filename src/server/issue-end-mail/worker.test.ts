import { eq, inArray } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { type MailMessage, MailRefused } from "../auth/mail.js";
import { actor, issue, issueEndMail, product } from "../db/schema.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp, TEST_ORIGIN, testAuthConfig } from "../test-app.js";
import { deriveUnsubscribeKey, unsubscribeUrl } from "./unsubscribe.js";
import {
  createIssueEndMailWorker,
  type IssueEndMailWorkerOptions,
} from "./worker.js";

const { app, db, bus, bot, request, inviteEmail, signInWithEmail, addMember } =
  setupTestApp();

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

function worker(
  transport: (m: MailMessage, signal?: AbortSignal) => Promise<void>,
  options: Partial<IssueEndMailWorkerOptions> = {},
) {
  return createIssueEndMailWorker({
    db,
    bus,
    mail: { from: FROM, publicUrl: TEST_ORIGIN, unsubscribeKey, transport },
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
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
  db.update(actor)
    .set({ issueEndMailOff: false })
    .where(eq(actor.id, person.id))
    .run();
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
  db.update(issueEndMail)
    .set({ state: "failed" })
    .where(eq(issueEndMail.id, rowOf(key).id))
    .run();
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
