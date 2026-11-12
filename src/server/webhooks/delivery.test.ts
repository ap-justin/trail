import { createHmac } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { webhookDelivery, webhookSubscription } from "../db/schema.js";
import { projectKey, setupTestApp, testWebhookSettings } from "../test-app.js";
import type { Transport } from "./send.js";
import { createWebhookWorker } from "./worker.js";

// A receiver on the loopback. trail refuses loopback addresses, so the transport
// under test stands where the TLS connection would be: it posts the signed
// request to the receiver and returns its status.
type Received = { headers: IncomingHttpHeaders; body: string };
const received: Received[] = [];
const statuses: number[] = [];
let receiver: Server;
let port = 0;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = statuses.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
  port = (receiver.address() as AddressInfo).port;
});
afterAll(() => {
  receiver.close();
});

const toReceiver: Transport = ({ headers, body }) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path: "/hook", headers },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    req.end(body);
  });

const { db, bus, request } = setupTestApp();
let resolveTo = ["93.184.216.34"];
let sends = 0;
const settings = testWebhookSettings({
  resolve: async () => resolveTo,
  transport: (call) => {
    sends++;
    return toReceiver(call);
  },
});
const SECRET = "whsec_delivery_0123456789abcdef";
const HOOK = "https://bot.example.com/hook";

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;
const api = async (method: string, path: string, json?: unknown) => {
  const res = await request(method, `/api/v1${path}`, { json });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return (await res.json()) as Body;
};

async function newProject() {
  const key = projectKey();
  await api("POST", "/projects", { key, name: `Project ${key}` });
  return key;
}
async function subscribe(projects: string[], url = HOOK) {
  return api("POST", "/webhooks", { url, secret: SECRET, projects });
}
const worker = (
  options: Partial<Parameters<typeof createWebhookWorker>[0]> = {},
) =>
  createWebhookWorker({
    db,
    bus,
    settings,
    backoffMs: [20],
    pollMs: 10,
    ...options,
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// each test starts with no subscriptions, so an earlier test's queue sends nothing in this one
const reset = () => {
  db.delete(webhookSubscription).run();
  received.length = 0;
  statuses.length = 0;
  sends = 0;
  resolveTo = ["93.184.216.34"];
};
/** Runs the worker's passes until `done`, or fails after a second. */
async function until(w: { tick(): Promise<void> }, done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await w.tick();
    if (!done()) await sleep(10);
  }
  expect(done()).toBe(true);
}
const rows = () => db.select().from(webhookDelivery).all();
const signatureOf = ({ headers, body }: Received, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret)
    .update(
      `${headers["x-openbot-timestamp"]}.${headers["x-openbot-delivery-id"]}.${body}`,
    )
    .digest("hex")}`;

test("an issue, a comment and a status change each arrive once, signed, in order", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/order");
  const issue = await api("POST", "/issues", {
    projectId: key,
    title: "First",
  });
  await api("POST", `/issues/${issue.key}/comments`, { body: "hello" });
  await api("PATCH", `/issues/${issue.key}`, { status: "in_progress" });

  const w = worker();
  await until(w, () => received.length >= 3);
  await w.tick();
  expect(received).toHaveLength(3);

  const messages = received.map((r) => JSON.parse(r.body));
  expect(messages.map((m) => m.type)).toEqual([
    "trail.issue.created",
    "trail.comment.created",
    "trail.issue.updated",
  ]);
  const seqs = messages.map((m) => m.data.seq);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  expect(
    new Set(received.map((r) => r.headers["x-openbot-delivery-id"])).size,
  ).toBe(3);
  for (const r of received) {
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["x-openbot-timestamp"]).toMatch(/^\d{10}$/);
    expect(r.headers["x-openbot-signature"]).toBe(signatureOf(r));
    // a different secret doesn't verify
    expect(r.headers["x-openbot-signature"]).not.toBe(
      signatureOf(r, "other-secret-other-secret"),
    );
  }
  const [created, commented, updated] = messages;
  expect(Number.isNaN(Date.parse(created.occurredAt))).toBe(false);
  expect(created.data).toMatchObject({
    project: { key, name: `Project ${key}` },
    subject: { type: "issue", key: issue.key, title: "First" },
    actor: { name: "tester", kind: "bot" },
    url: `https://trail-justin.fly.dev/issues/${issue.key}`,
    payload: expect.objectContaining({ title: "First" }),
  });
  expect(created.data.eventId).toEqual(expect.any(String));
  expect(commented.data.subject).toMatchObject({
    type: "comment",
    key: issue.key,
    title: "First",
  });
  expect(commented.data.payload.body).toBe("hello");
  expect(updated.data.payload.status).toEqual({
    from: "open",
    to: "in_progress",
  });

  const after = (await api("GET", `/webhooks/${hook.id}`)) as Body;
  expect(after).toMatchObject({
    paused: false,
    consecutiveFailures: 0,
    lastError: null,
  });
  expect(after.lastSuccessAt).not.toBeNull();
  expect(
    rows()
      .filter((r) => r.subscriptionId === hook.id)
      .every((r) => r.status === "delivered"),
  ).toBe(true);
});

test("nothing arrives for a project the webhook doesn't follow", async () => {
  reset();
  const followed = await newProject();
  const other = await newProject();
  await subscribe([followed], "https://bot.example.com/only-followed");
  await api("POST", "/issues", { projectId: other, title: "elsewhere" });
  const w = worker();
  await w.tick();
  await sleep(30);
  await w.tick();
  const types = received.map((r) => JSON.parse(r.body).data.project.key);
  expect(types).not.toContain(other);
});

test("a 500 then a 200 retries under the same delivery id, and holds later deliveries behind it", async () => {
  reset();
  const key = await newProject();
  await subscribe([key], "https://bot.example.com/retry");
  statuses.push(500, 200);
  const one = await api("POST", "/issues", { projectId: key, title: "one" });
  await api("POST", "/issues", { projectId: key, title: "two" });

  const w = worker();
  await w.tick();
  // the first attempt failed; "two" waits behind it
  expect(received).toHaveLength(1);
  await until(w, () => received.length >= 3);
  expect(received.map((r) => JSON.parse(r.body).data.subject.title)).toEqual([
    "one",
    "one",
    "two",
  ]);
  expect(received[0]?.headers["x-openbot-delivery-id"]).toBe(
    received[1]?.headers["x-openbot-delivery-id"],
  );
  expect(received[1]?.headers["x-openbot-delivery-id"]).not.toBe(
    received[2]?.headers["x-openbot-delivery-id"],
  );
  // a retry sends the same bytes, freshly signed
  expect(received[1]?.body).toBe(received[0]?.body);
  for (const r of received)
    expect(r.headers["x-openbot-signature"]).toBe(signatureOf(r));
  const first = rows().find(
    (r) => r.id === received[0]?.headers["x-openbot-delivery-id"],
  );
  expect(first).toMatchObject({ status: "delivered", attempts: 2 });
  void one;
});

test("a status the receiver won't change on a retry fails that delivery and moves on", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/bad-request");
  statuses.push(400, 200);
  await api("POST", "/issues", { projectId: key, title: "rejected" });
  await api("POST", "/issues", { projectId: key, title: "accepted" });
  const w = worker();
  await until(w, () => received.length >= 2);
  const mine = rows().filter((r) => r.subscriptionId === hook.id);
  expect(mine.map((r) => [r.status, r.lastStatus])).toEqual([
    ["failed", 400],
    ["delivered", 200],
  ]);
});

test("an outbox row survives a restart: a fresh worker sends what an earlier run never did", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/restart");
  await api("POST", "/issues", { projectId: key, title: "while down" });
  // no worker has run: the row is already in the database
  const queued = rows().filter((r) => r.subscriptionId === hook.id);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    status: "pending",
    attempts: 0,
    type: "trail.issue.created",
  });
  expect(received).toHaveLength(0);

  const afterRestart = worker();
  afterRestart.start();
  await until(afterRestart, () => received.length === 1);
  await afterRestart.stop();
  expect(JSON.parse(received[0]?.body ?? "").data.subject.title).toBe(
    "while down",
  );
  expect(rows().find((r) => r.id === queued[0]?.id)?.status).toBe("delivered");
});

test("the bus wakes a running worker without waiting for its poll", async () => {
  reset();
  const key = await newProject();
  await subscribe([key], "https://bot.example.com/bus");
  const w = worker({ pollMs: 60_000 });
  w.start();
  await api("POST", "/issues", { projectId: key, title: "pushed" });
  for (let i = 0; i < 100 && received.length === 0; i++) await sleep(10);
  await w.stop();
  expect(received).toHaveLength(1);
});

test("repeated failures pause the subscription, shown in its listing, and an update resumes it", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/pause");
  statuses.push(503, 503, 503);
  await api("POST", "/issues", { projectId: key, title: "stuck" });
  await api("POST", "/issues", { projectId: key, title: "behind" });
  const w = worker({ pauseAfter: 3, backoffMs: [5] });
  const paused = async () => (await api("GET", `/webhooks/${hook.id}`)).paused;
  for (let i = 0; i < 100 && !(await paused()); i++) {
    await w.tick();
    await sleep(10);
  }
  const listed = (await api("GET", "/webhooks")).items.find(
    (x: Body) => x.id === hook.id,
  );
  expect(listed).toMatchObject({
    paused: true,
    consecutiveFailures: 3,
    lastError: "HTTP 503",
    lastSuccessAt: null,
  });
  expect(listed.pausedAt).not.toBeNull();
  expect(listed.lastErrorAt).not.toBeNull();

  const count = received.length;
  await sleep(30);
  await w.tick();
  expect(received).toHaveLength(count);

  // the bot's update resumes it, and what waited goes out in order
  const resumed = await api("PATCH", `/webhooks/${hook.id}`, {});
  expect(resumed).toMatchObject({ paused: false, consecutiveFailures: 0 });
  await until(w, () => received.length >= count + 2);
  expect(
    received.slice(count).map((r) => JSON.parse(r.body).data.subject.title),
  ).toEqual(["stuck", "behind"]);
  expect(
    (await api("GET", `/webhooks/${hook.id}`)).lastSuccessAt,
  ).not.toBeNull();
});

test("a delivery still failing after the retry window is marked failed", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/giveup");
  statuses.push(...Array(50).fill(502));
  await api("POST", "/issues", { projectId: key, title: "doomed" });
  const w = worker({ giveUpMs: 60, backoffMs: [15], pauseAfter: 1000 });
  await until(w, () =>
    rows().some((r) => r.subscriptionId === hook.id && r.status === "failed"),
  );
  const row = rows().find((r) => r.subscriptionId === hook.id);
  expect(row?.lastError).toBe("HTTP 502");
  expect(row?.attempts).toBeGreaterThan(1);
  statuses.length = 0;
});

test("DNS that now points inside is refused at delivery, with no request sent", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/rebind");
  await api("POST", "/issues", { projectId: key, title: "rebind" });
  resolveTo = ["10.0.0.7"];
  const w = worker({ pauseAfter: 1000 });
  await w.tick();
  expect(sends).toBe(0);
  const row = rows().find((r) => r.subscriptionId === hook.id);
  expect(row).toMatchObject({ status: "pending", attempts: 1 });
  expect(row?.lastError).toMatch(/internal address/);
});

test("a payload over 2000 characters is cut", async () => {
  reset();
  const key = await newProject();
  await subscribe([key], "https://bot.example.com/cut");
  await api("POST", "/issues", {
    projectId: key,
    title: "big",
    description: "x".repeat(5000),
  });
  const w = worker();
  await until(w, () => received.length === 1);
  const { payload } = JSON.parse(received[0]?.body ?? "").data;
  expect(payload.truncated).toBe(true);
  expect(payload.json).toHaveLength(2000);
});

test("deleting a webhook drops its queued deliveries", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/gone");
  await api("POST", "/issues", { projectId: key, title: "queued" });
  expect(rows().filter((r) => r.subscriptionId === hook.id)).toHaveLength(1);
  await api("DELETE", `/webhooks/${hook.id}`);
  expect(rows().filter((r) => r.subscriptionId === hook.id)).toHaveLength(0);
});
