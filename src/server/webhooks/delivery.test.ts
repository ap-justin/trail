import { createHmac } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { webhookDelivery, webhookSubscription } from "../db/schema.js";
import { isPending, unfollowedDeliveries } from "../service/webhooks.js";
import { projectKey, setupTestApp, testWebhookSettings } from "../test-app.js";
import { deriveSecretKey, sealSecret } from "./secret.js";
import { sendWebhook, type Transport } from "./send.js";
import {
  BACKOFF_MS,
  createWebhookWorker,
  expireQuery,
  headsQuery,
} from "./worker.js";

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

const postTo =
  (to: () => number): Transport =>
  ({ headers, body, signal }) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: to(),
          method: "POST",
          path: "/hook",
          headers,
          signal,
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
const toReceiver = postTo(() => port);

// the app and the worker share one clock that stands still until a test moves it: a backoff
// or a retry window is crossed by advancing it, never by waiting
let clock = Date.now();
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const { db, bus, request } = setupTestApp({ webhooks: { now } });
let resolveTo = ["93.184.216.34"];
let sends = 0;
// the path of every send, and a path whose receiver answers 503 without being reached
const sentTo: string[] = [];
let failPath: string | null = null;
const PUBLIC_URL = "https://trail.example/";
const settings = testWebhookSettings({
  publicUrl: PUBLIC_URL,
  now,
  resolve: async () => resolveTo,
  transport: (call) => {
    sends++;
    sentTo.push(call.url.pathname);
    if (call.url.pathname === failPath) return Promise.resolve({ status: 503 });
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
async function subscribe(projects: string[], url = HOOK, secret = SECRET) {
  return api("POST", "/webhooks", { url, secret, projects });
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
  sentTo.length = 0;
  failPath = null;
  resolveTo = ["93.184.216.34"];
  clock = Date.now();
};
/** Runs the worker's passes until `done`, a second of the shared clock apart, or fails after 100. */
async function until(w: { tick(): Promise<void> }, done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await w.tick();
    if (!done()) advance(SECOND);
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
    url: `https://trail.example/issues/${issue.key}`,
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

test("nothing arrives for a project the webhook doesn't follow, while its own project's events do", async () => {
  reset();
  const followed = await newProject();
  const other = await newProject();
  const hook = await subscribe(
    [followed],
    "https://bot.example.com/only-followed",
  );
  await api("POST", "/issues", { projectId: other, title: "elsewhere" });
  await api("POST", "/issues", { projectId: followed, title: "mine" });
  const w = worker();
  await w.tick();
  expect(received.map((r) => JSON.parse(r.body).data.project.key)).toEqual([
    followed,
  ]);
  // nothing was even queued for the other project's event
  expect(rows().filter((r) => r.subscriptionId === hook.id)).toHaveLength(1);
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
  // the first attempt failed; "two" waits behind it, and nothing is due until the backoff passes
  expect(received).toHaveLength(1);
  await w.tick();
  expect(received).toHaveLength(1);
  advance(20);
  await w.tick();
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
  expect(received).toHaveLength(3);
  const first = rows().find(
    (r) => r.id === received[0]?.headers["x-openbot-delivery-id"],
  );
  expect(first).toMatchObject({ status: "delivered", attempts: 2 });
  void one;
});

test("a 401, 403 or 404 from a receiver mid-deploy is retried, and the delivery goes out", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/redeploying");
  statuses.push(401, 403, 404, 200);
  await api("POST", "/issues", { projectId: key, title: "during deploy" });
  const w = worker({ pauseAfter: 1000 });
  await until(w, () => received.length >= 4);
  expect(
    new Set(received.map((r) => r.headers["x-openbot-delivery-id"])).size,
  ).toBe(1);
  const mine = rows().filter((r) => r.subscriptionId === hook.id);
  expect(mine.map((r) => [r.status, r.attempts, r.lastStatus])).toEqual([
    ["delivered", 4, 200],
  ]);
});

test("a 410 Gone fails that delivery at once and moves on", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/gone-410");
  statuses.push(410, 200);
  await api("POST", "/issues", { projectId: key, title: "rejected" });
  await api("POST", "/issues", { projectId: key, title: "accepted" });
  const w = worker();
  await until(w, () => received.length >= 2);
  const mine = rows().filter((r) => r.subscriptionId === hook.id);
  expect(mine.map((r) => [r.status, r.attempts, r.lastStatus])).toEqual([
    ["failed", 1, 410],
    ["delivered", 1, 200],
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
  for (let i = 0; i < 3; i++) {
    await w.tick();
    advance(10);
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
  expect(count).toBe(3);
  advance(HOUR);
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
  const w = worker({ giveUpMs: 50_000, backoffMs: [15_000], pauseAfter: 1000 });
  const mine = () => rows().filter((r) => r.subscriptionId === hook.id);
  // attempts at 0s, 15s, 30s and 45s: the fourth would retry at 60s, past the 50s window
  for (let i = 0; i < 4; i++) {
    await w.tick();
    expect(mine()[0]?.status, `after attempt ${i + 1}`).toBe(
      i < 3 ? "pending" : "failed",
    );
    advance(15_000);
  }
  expect(mine()[0]).toMatchObject({
    status: "failed",
    attempts: 4,
    lastError: "HTTP 502",
  });
  statuses.length = 0;
});

test("a paused webhook's deliveries wait past the retry window and go out on resume", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe(
    [key],
    "https://bot.example.com/paused-overnight",
  );
  statuses.push(503);
  await api("POST", "/issues", { projectId: key, title: "overnight" });
  const w = worker({ pauseAfter: 1 });
  await w.tick();
  expect((await api("GET", `/webhooks/${hook.id}`)).paused).toBe(true);

  advance(25 * HOUR);
  await w.tick();
  const waiting = rows().find((r) => r.subscriptionId === hook.id);
  expect(waiting).toMatchObject({ status: "pending", attempts: 1 });

  await api("PATCH", `/webhooks/${hook.id}`, {});
  await until(w, () => received.length >= 2);
  expect(rows().find((r) => r.subscriptionId === hook.id)).toMatchObject({
    status: "delivered",
    attempts: 2,
  });
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

test("with no public URL configured a delivery carries no link", async () => {
  reset();
  const key = await newProject();
  await subscribe([key], "https://bot.example.com/nolink");
  await api("POST", "/issues", { projectId: key, title: "unlinked" });
  const w = worker({ settings: { ...settings, publicUrl: undefined } });
  await until(w, () => received.length === 1);
  const { data } = JSON.parse(received[0]?.body ?? "");
  expect(data.subject.title).toBe("unlinked");
  expect(data).not.toHaveProperty("url");
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

/** A receiver that takes the request, then drips its response head a line every few ms: never idle, never done. */
async function dripReceiver() {
  let dripping = () => {};
  const started = new Promise<void>((done) => {
    dripping = done;
  });
  const drips = new Set<NodeJS.Timeout>();
  const server = createTcpServer((socket) => {
    // an abort resets the connection
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\n");
      const drip = setInterval(() => socket.write("x-drip: 1\r\n"), 5);
      drips.add(drip);
      socket.on("close", () => clearInterval(drip));
      dripping();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    transport: postTo(() => (server.address() as AddressInfo).port),
    started,
    close() {
      for (const drip of drips) clearInterval(drip);
      server.close();
    },
  };
}

test("a receiver that drips its response head is cut off at the deadline", async () => {
  const slow = await dripReceiver();
  const deadline = new AbortController();
  try {
    const sent = sendWebhook(
      {
        ...settings,
        transport: slow.transport,
        deadline: () => deadline.signal,
      },
      { url: HOOK, secret: SECRET, deliveryId: "drip", body: "{}" },
    );
    await slow.started;
    deadline.abort();
    expect(await sent).toEqual({
      ok: false,
      status: null,
      error: "no answer within 10s",
      retryable: true,
    });
  } finally {
    slow.close();
  }
});

test("stopping the worker cuts a send in flight, and its delivery stays pending", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/shutdown");
  await api("POST", "/issues", { projectId: key, title: "in flight" });
  const slow = await dripReceiver();
  try {
    const w = worker({ settings: { ...settings, transport: slow.transport } });
    w.start();
    await slow.started;
    await w.stop();
    expect(rows().find((r) => r.subscriptionId === hook.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  } finally {
    slow.close();
  }
});

// the shipped schedule and threshold, not the shortened ones the tests above pass
const shipped = () => createWebhookWorker({ db, bus, settings });
/** Moves the clock to when the earliest retry is due, no further. */
const advanceToDue = () => {
  const due = rows()
    .filter((r) => r.status === "pending")
    .map((r) => r.nextAttemptAt.getTime());
  if (due.length > 0) clock = Math.max(clock, Math.min(...due));
};
const sub = (id: string) =>
  db
    .select()
    .from(webhookSubscription)
    .all()
    .find((x) => x.id === id);

test("the shipped backoff waits 10s, 30s, 2m, 10m, 30m, 1h, 2h, then 4h, and nothing is sent before it is up", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/schedule");
  statuses.push(...Array(9).fill(503));
  await api("POST", "/issues", { projectId: key, title: "slow receiver" });
  // pause is out of the way: this is the schedule alone
  const w = createWebhookWorker({ db, bus, settings, pauseAfter: 1000 });
  const mine = () => rows().filter((r) => r.subscriptionId === hook.id)[0];
  const waits = [
    10 * SECOND,
    30 * SECOND,
    2 * MINUTE,
    10 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    4 * HOUR,
    4 * HOUR,
  ];
  expect(BACKOFF_MS).toEqual(waits.slice(0, 8));
  for (const [i, wait] of waits.entries()) {
    await w.tick();
    expect(sends, `attempt ${i + 1}`).toBe(i + 1);
    expect(
      (mine()?.nextAttemptAt.getTime() ?? 0) - clock,
      `wait ${i + 1}`,
    ).toBe(wait);
    advance(wait - 1);
    await w.tick();
    expect(sends, `one ms early, after attempt ${i + 1}`).toBe(i + 1);
    advance(1);
  }
});

test("a delivery that keeps failing is given up on once the next try would fall past 24 hours", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/day");
  statuses.push(...Array(30).fill(503));
  await api("POST", "/issues", { projectId: key, title: "never answered" });
  const w = createWebhookWorker({ db, bus, settings, pauseAfter: 1000 });
  const mine = () => rows().filter((r) => r.subscriptionId === hook.id)[0];
  const created = mine()?.createdAt.getTime() ?? 0;
  let lastAttempt = clock;
  for (let i = 0; i < 30 && mine()?.status === "pending"; i++) {
    lastAttempt = clock;
    await w.tick();
    if (mine()?.status === "pending") advanceToDue();
  }
  // attempts at 0s, 10s, 40s, 2m40s, 12m40s, 42m40s, 1h42m40s, 3h42m40s, then every 4h: the 13th, at 23h42m40s,
  // would wait to 27h42m40s
  expect(mine()).toMatchObject({ status: "failed", attempts: 13 });
  expect(lastAttempt - created).toBeGreaterThan(23 * HOUR);
  expect(lastAttempt - created).toBeLessThan(24 * HOUR);
  statuses.length = 0;
});

test("a delivery 24 hours old is failed, however late the receiver is tried again", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/late");
  statuses.push(...Array(5).fill(503));
  await api("POST", "/issues", { projectId: key, title: "stale" });
  const w = createWebhookWorker({ db, bus, settings, pauseAfter: 1000 });
  const mine = () => rows().filter((r) => r.subscriptionId === hook.id)[0];
  const created = mine()?.createdAt.getTime() ?? 0;
  await w.tick();
  // 10 minutes inside the window the retry still goes out and is still pending
  clock = created + 24 * HOUR - 10 * MINUTE;
  await w.tick();
  expect(mine()).toMatchObject({ status: "pending", attempts: 2 });
  // 10 minutes past it nothing is sent: the delivery is failed with the last answer kept
  clock = created + 24 * HOUR + 10 * MINUTE;
  await w.tick();
  expect(sends).toBe(2);
  expect(mine()).toMatchObject({
    status: "failed",
    attempts: 2,
    lastError: "HTTP 503",
  });
  statuses.length = 0;
});

test("seven failures in a row don't pause, the eighth does", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/eight");
  statuses.push(...Array(8).fill(503));
  await api("POST", "/issues", { projectId: key, title: "flapping" });
  const w = shipped();
  for (let i = 1; i <= 7; i++) {
    await w.tick();
    advanceToDue();
    expect(sub(hook.id), `after ${i} failures`).toMatchObject({
      consecutiveFailures: i,
      pausedAt: null,
    });
  }
  await w.tick();
  expect(sub(hook.id)).toMatchObject({ consecutiveFailures: 8 });
  expect(sub(hook.id)?.pausedAt).not.toBeNull();
});

test("a success resets the count, so only failures in a row pause", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/streak");
  const w = shipped();
  // three failures, then it answers
  statuses.push(503, 503, 503, 200);
  await api("POST", "/issues", { projectId: key, title: "first" });
  for (let i = 0; i < 4; i++) {
    await w.tick();
    advanceToDue();
  }
  expect(sub(hook.id)).toMatchObject({
    consecutiveFailures: 0,
    pausedAt: null,
  });
  // seven more would reach eight only if the three before them still counted
  statuses.push(...Array(7).fill(503));
  await api("POST", "/issues", { projectId: key, title: "second" });
  for (let i = 0; i < 7; i++) {
    await w.tick();
    advanceToDue();
  }
  expect(sub(hook.id)).toMatchObject({
    consecutiveFailures: 7,
    pausedAt: null,
  });
});

test("a delivery a receiver refuses for good still counts toward the pause", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/refuser");
  statuses.push(...Array(8).fill(410));
  const w = shipped();
  for (let i = 1; i <= 8; i++) {
    await api("POST", "/issues", { projectId: key, title: `refused ${i}` });
    await w.tick();
    expect(sub(hook.id)?.consecutiveFailures).toBe(i);
    expect(sub(hook.id)?.pausedAt === null, `after ${i}`).toBe(i < 8);
  }
  expect(
    rows().filter((r) => r.subscriptionId === hook.id && r.status === "failed"),
  ).toHaveLength(8);
});

test("one event reaches every webhook that follows its project, each signed with its own secret", async () => {
  reset();
  const key = await newProject();
  const other = await newProject();
  const first = await subscribe(
    [key],
    "https://bot.example.com/one",
    "whsec_first_0123456789abcdef",
  );
  const second = await subscribe(
    [key, other],
    "https://bot.example.com/two",
    "whsec_second_0123456789abcdef",
  );
  await api("POST", "/issues", { projectId: key, title: "for both" });
  await worker().tick();
  expect(sentTo.sort()).toEqual(["/one", "/two"]);
  const [x, y] = received;
  expect(x?.headers["x-openbot-delivery-id"]).not.toBe(
    y?.headers["x-openbot-delivery-id"],
  );
  expect(x?.body).toBe(y?.body);
  const secrets = [
    "whsec_first_0123456789abcdef",
    "whsec_second_0123456789abcdef",
  ];
  // arrival order isn't fixed: each message verifies under exactly one of the two secrets
  for (const r of received) {
    expect(
      secrets.filter(
        (s) => r.headers["x-openbot-signature"] === signatureOf(r, s),
      ),
    ).toHaveLength(1);
  }
  expect(
    rows()
      .filter((r) => [first.id, second.id].includes(r.subscriptionId))
      .map((r) => r.status),
  ).toEqual(["delivered", "delivered"]);
});

test("a webhook that keeps failing doesn't hold back another one on the same project", async () => {
  reset();
  const key = await newProject();
  const down = await subscribe([key], "https://bot.example.com/down");
  await subscribe([key], "https://bot.example.com/up");
  failPath = "/down";
  for (const title of ["one", "two", "three"]) {
    await api("POST", "/issues", { projectId: key, title });
  }
  const w = worker({ pauseAfter: 1000 });
  await until(w, () => received.length === 3);
  expect(received.map((r) => JSON.parse(r.body).data.subject.title)).toEqual([
    "one",
    "two",
    "three",
  ]);
  // the failing one is still on its first delivery, retrying; the others wait behind it
  const stuck = rows().filter((r) => r.subscriptionId === down.id);
  expect(stuck.map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
  expect(stuck.map((r) => r.attempts > 0)).toEqual([true, false, false]);
});

test("events created while a webhook is paused queue behind it and go out in order on resume", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/paused-queue");
  failPath = "/paused-queue";
  await api("POST", "/issues", { projectId: key, title: "before" });
  const w = worker({ pauseAfter: 1 });
  await w.tick();
  expect(sub(hook.id)?.pausedAt).not.toBeNull();

  await api("POST", "/issues", { projectId: key, title: "during one" });
  await api("POST", "/issues", { projectId: key, title: "during two" });
  const queued = rows().filter((r) => r.subscriptionId === hook.id);
  expect(queued.map((r) => r.status)).toEqual([
    "pending",
    "pending",
    "pending",
  ]);
  advance(HOUR);
  await w.tick();
  expect(sentTo).toEqual(["/paused-queue"]);

  failPath = null;
  await api("PATCH", `/webhooks/${hook.id}`, {});
  await until(w, () => received.length === 3);
  expect(received.map((r) => JSON.parse(r.body).data.subject.title)).toEqual([
    "before",
    "during one",
    "during two",
  ]);
});

test("a delivery queued before a rotation is signed with the new secret", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/rotate");
  await api("POST", "/issues", { projectId: key, title: "queued" });
  const next = "whsec_rotated_0123456789abcdef";
  await api("PUT", `/webhooks/${hook.id}/secret`, { secret: next });
  await worker().tick();
  const [only] = received;
  expect(received).toHaveLength(1);
  expect(only?.headers["x-openbot-signature"]).toBe(
    signatureOf(only as Received, next),
  );
  expect(only?.headers["x-openbot-signature"]).not.toBe(
    signatureOf(only as Received, SECRET),
  );
});

test("rotating the secret of a paused webhook resumes it, and what waited goes out under the new secret", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/rotate-resume");
  failPath = "/rotate-resume";
  await api("POST", "/issues", { projectId: key, title: "held" });
  const w = worker({ pauseAfter: 1 });
  await w.tick();
  expect(sub(hook.id)?.pausedAt).not.toBeNull();

  failPath = null;
  const next = "whsec_resumed_0123456789abcdef";
  const rotated = await api("PUT", `/webhooks/${hook.id}/secret`, {
    secret: next,
  });
  expect(rotated).toMatchObject({ paused: false, consecutiveFailures: 0 });
  advance(HOUR);
  await until(w, () => received.length === 1);
  expect(received[0]?.headers["x-openbot-signature"]).toBe(
    signatureOf(received[0] as Received, next),
  );
});

/** Makes SQLite abort the delivery updates `when` matches, until the returned function drops the trigger. */
function failDeliveryUpdates(when: string) {
  db.$client.exec(
    `create trigger fail_delivery_update before update on webhook_delivery when ${when} begin select raise(abort, 'disk on fire'); end`,
  );
  return () => db.$client.exec("drop trigger if exists fail_delivery_update");
}
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

test("a delivery whose outcome can't be written is sent again only after a wait, and other webhooks still deliver", async () => {
  reset();
  const key = await newProject();
  const broken = await subscribe([key], "https://bot.example.com/unrecorded");
  await subscribe([key], "https://bot.example.com/healthy");
  const logged = quiet();
  // the body cache is written, the attempt's outcome is not
  const restore = failDeliveryUpdates(
    `new.subscription_id = '${broken.id}' and new.attempts <> old.attempts`,
  );
  try {
    await api("POST", "/issues", { projectId: key, title: "one" });
    const w = worker();
    await w.tick();
    await w.tick();
    await w.tick();
    expect(sentTo.filter((p) => p === "/unrecorded")).toHaveLength(1);
    expect(sentTo.filter((p) => p === "/healthy")).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      "webhook delivery crashed",
      expect.any(String),
      expect.anything(),
    );
    // once the wait is up it is sent again, under the same id
    advance(SECOND);
    await w.tick();
    expect(sentTo.filter((p) => p === "/unrecorded")).toHaveLength(2);
  } finally {
    restore();
    logged.mockRestore();
  }
});

test("a delivery that crashes before it is sent is recorded as a retryable failure and waits out its backoff", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/unbuildable");
  const logged = quiet();
  // the body can't be cached, so the attempt throws before any request
  const restore = failDeliveryUpdates(
    `new.subscription_id = '${hook.id}' and new.body is not null`,
  );
  try {
    await api("POST", "/issues", { projectId: key, title: "one" });
    const w = worker({ backoffMs: [MINUTE] });
    await w.tick();
    await w.tick();
    expect(sends).toBe(0);
    const row = rows().find((r) => r.subscriptionId === hook.id);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "internal error",
    });
    expect((row?.nextAttemptAt.getTime() ?? 0) - clock).toBe(MINUTE);
    expect(sub(hook.id)?.consecutiveFailures).toBe(1);
  } finally {
    restore();
    logged.mockRestore();
  }
});

test("a pass that fails is logged, never rejected, and stopping still settles", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/unexpirable");
  statuses.push(503);
  await api("POST", "/issues", { projectId: key, title: "old" });
  const w = worker({ giveUpMs: HOUR, pauseAfter: 1000 });
  await w.tick();
  const logged = quiet();
  // the expiry sweep itself throws
  const restore = failDeliveryUpdates(
    `new.subscription_id = '${hook.id}' and new.status = 'failed'`,
  );
  try {
    advance(2 * HOUR);
    await expect(w.tick()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(
      "webhook pass failed",
      expect.anything(),
    );
    w.start();
    await expect(w.stop()).resolves.toBeUndefined();
  } finally {
    restore();
    logged.mockRestore();
  }
});

/** A transport that holds every request to `path` until `release()`, and sends the rest on. */
function holding(path: string) {
  let release = () => {};
  const released = new Promise<void>((done) => {
    release = done;
  });
  const held: string[] = [];
  const transport: Transport = async (call) => {
    if (call.url.pathname !== path) return settings.transport(call);
    held.push(call.headers["x-openbot-delivery-id"] ?? "");
    await released;
    return settings.transport(call);
  };
  return { transport, held, release };
}
/** The titles a webhook's receiver got, in arrival order. */
const titles = (hook: Body) => {
  const mine = new Set(
    rows()
      .filter((r) => r.subscriptionId === hook.id)
      .map((r) => r.id),
  );
  return received
    .filter((r) => mine.has(String(r.headers["x-openbot-delivery-id"])))
    .map((r) => JSON.parse(r.body).data.subject.title);
};

test("a slow receiver doesn't hold up another webhook's deliveries", async () => {
  reset();
  const key = await newProject();
  const slowHook = await subscribe([key], "https://bot.example.com/slow");
  const fastHook = await subscribe([key], "https://bot.example.com/fast");
  const slow = holding("/slow");
  const w = worker({ settings: { ...settings, transport: slow.transport } });
  await api("POST", "/issues", { projectId: key, title: "one" });
  const first = w.tick();
  await vi.waitFor(() => expect(titles(fastHook)).toEqual(["one"]));
  // the slow receiver still has "one"; the fast one's next event goes out anyway
  await api("POST", "/issues", { projectId: key, title: "two" });
  const second = w.tick();
  await vi.waitFor(() => expect(titles(fastHook)).toEqual(["one", "two"]));
  expect(slow.held).toHaveLength(1);
  slow.release();
  await Promise.all([first, second]);
  await w.tick();
  expect(titles(slowHook)).toEqual(["one", "two"]);
});

test("the bus wakes the worker after the write that published, not inside it", async () => {
  reset();
  const key = await newProject();
  await subscribe([key], "https://bot.example.com/deferred");
  let lookups = 0;
  const w = worker({
    pollMs: 60_000,
    settings: {
      ...settings,
      resolve: async () => {
        lookups++;
        return resolveTo;
      },
    },
  });
  w.start();
  await w.tick();
  // subscribers run in order, so this one sees what the worker's did during the publish
  const duringPublish: number[] = [];
  const off = bus.subscribe(() => duringPublish.push(lookups));
  try {
    await api("POST", "/issues", { projectId: key, title: "deferred" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(duringPublish).toEqual([0]);
  } finally {
    off();
    await w.stop();
  }
});

test("an event during a send in flight doesn't send the head twice, and goes out after it", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/overlap");
  const slow = holding("/overlap");
  const w = worker({
    pollMs: 60_000,
    settings: { ...settings, transport: slow.transport },
  });
  await api("POST", "/issues", { projectId: key, title: "first" });
  w.start();
  try {
    await vi.waitFor(() => expect(slow.held).toHaveLength(1));
    // the bus wakes it and a pass runs too, both while "first" is in flight
    await api("POST", "/issues", { projectId: key, title: "second" });
    void w.tick();
    await new Promise((done) => setImmediate(done));
    expect(slow.held).toHaveLength(1);
    slow.release();
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await w.tick();
    expect(titles(hook)).toEqual(["first", "second"]);
    expect(
      new Set(received.map((r) => r.headers["x-openbot-delivery-id"])).size,
    ).toBe(2);
  } finally {
    await w.stop();
  }
});

test("a stop between the receiver's answer and the row's update sends that delivery again under the same id", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/answered");
  await api("POST", "/issues", { projectId: key, title: "twice" });
  // the receiver gets it and answers 200, but the worker is stopped before it can record that
  const stopping: Transport = async (call) => {
    void first.stop();
    return settings.transport({ ...call, signal: undefined });
  };
  const first = worker({ settings: { ...settings, transport: stopping } });
  await first.tick();
  expect(received).toHaveLength(1);
  expect(rows().find((r) => r.subscriptionId === hook.id)).toMatchObject({
    status: "pending",
    attempts: 0,
  });

  await worker().tick();
  expect(received).toHaveLength(2);
  expect(received[1]?.headers["x-openbot-delivery-id"]).toBe(
    received[0]?.headers["x-openbot-delivery-id"],
  );
  expect(rows().find((r) => r.subscriptionId === hook.id)).toMatchObject({
    status: "delivered",
    attempts: 1,
  });
});

test("a stored secret that can't be read sends nothing and says to rotate, until the bot rotates it", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/stranded");
  // sealed under a server secret this server no longer has
  db.update(webhookSubscription)
    .set({
      secretCipher: sealSecret(
        deriveSecretKey("an-earlier-server-secret-of-32-characters"),
        hook.id,
        SECRET,
      ),
    })
    .run();
  await api("POST", "/issues", { projectId: key, title: "stranded" });
  const w = worker({ pauseAfter: 1000 });
  await w.tick();
  advance(SECOND);
  await w.tick();
  expect(sends).toBe(0);
  const row = rows().find((r) => r.subscriptionId === hook.id);
  expect(row).toMatchObject({ status: "pending", attempts: 2 });
  expect(row?.lastError).toMatch(/rotate_webhook_secret/);
  expect(sub(hook.id)?.consecutiveFailures).toBe(2);

  const next = "whsec_after_restore_0123456789";
  await api("PUT", `/webhooks/${hook.id}/secret`, { secret: next });
  await until(w, () => received.length === 1);
  expect(received[0]?.headers["x-openbot-signature"]).toBe(
    signatureOf(received[0] as Received, next),
  );
});

test("a poll reads one head per unpaused webhook, never a paused webhook's backlog", async () => {
  reset();
  const key = await newProject();
  const paused = await subscribe(
    [key],
    "https://bot.example.com/paused-backlog",
  );
  db.update(webhookSubscription)
    .set({ pausedAt: new Date(now()) })
    .where(eq(webhookSubscription.id, paused.id))
    .run();
  for (let i = 0; i < 20; i++) {
    await api("POST", "/issues", { projectId: key, title: `backlog ${i}` });
  }
  expect(rows().filter((r) => r.status === "pending")).toHaveLength(20);

  // the plan, not the timing: a scan of webhook_delivery reads every pending row, the paused backlog included
  const { sql, params } = headsQuery(db).toSQL();
  const plan = db.$client
    .prepare(`explain query plan ${sql}`)
    .all(...params)
    .map((step) => (step as { detail: string }).detail);
  expect(plan.filter((step) => step.startsWith("SCAN"))).toEqual([
    "SCAN webhook_subscription",
  ]);
  expect(headsQuery(db).all()).toEqual([]);
});

test("the heads are each unpaused webhook's oldest pending delivery, in event order", async () => {
  reset();
  const key = await newProject();
  const ahead = await subscribe([key], "https://bot.example.com/ahead");
  const behind = await subscribe([key], "https://bot.example.com/behind");
  const paused = await subscribe([key], "https://bot.example.com/paused");
  for (const title of ["one", "two", "three"]) {
    await api("POST", "/issues", { projectId: key, title });
  }
  const queue = (id: string) =>
    rows()
      .filter((r) => r.subscriptionId === id)
      .sort((a, b) => a.seq - b.seq);
  const [first] = queue(ahead.id);
  db.update(webhookDelivery)
    .set({ status: "delivered", deliveredAt: new Date(now()) })
    .where(eq(webhookDelivery.id, first?.id ?? ""))
    .run();
  db.update(webhookSubscription)
    .set({ pausedAt: new Date(now()) })
    .where(eq(webhookSubscription.id, paused.id))
    .run();

  const heads = (id?: string) =>
    headsQuery(db, id)
      .all()
      .map((h) => h.delivery.id);
  expect(heads()).toEqual([queue(behind.id)[0]?.id, queue(ahead.id)[1]?.id]);
  expect(heads(ahead.id)).toEqual([queue(ahead.id)[1]?.id]);
  expect(heads(paused.id)).toEqual([]);
});

test("a redirect keeps the delivery pending and counts toward the pause", async () => {
  reset();
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/moved");
  statuses.push(302, 302);
  await api("POST", "/issues", { projectId: key, title: "redirected" });
  const w = worker({ pauseAfter: 2, backoffMs: [5] });
  await w.tick();
  const row = () => rows().find((r) => r.subscriptionId === hook.id);
  expect(row()).toMatchObject({
    status: "pending",
    attempts: 1,
    lastStatus: 302,
  });
  expect(row()?.lastError).toContain("set the subscription to the final URL");
  expect((await api("GET", `/webhooks/${hook.id}`)).consecutiveFailures).toBe(
    1,
  );
  advance(10);
  await w.tick();
  expect(row()).toMatchObject({ status: "pending", attempts: 2 });
  expect(await api("GET", `/webhooks/${hook.id}`)).toMatchObject({
    paused: true,
    consecutiveFailures: 2,
  });
});

// the plan, and the SQL text: 'pending' is a literal there, not a bound value, which is
// what lets the planner match the partial index whatever SQLite binds at prepare time
const planOf = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
  const { sql, params } = query.toSQL();
  expect(params).not.toContain("pending");
  expect(sql).toContain("'pending'");
  return db.$client
    .prepare(`explain query plan ${sql}`)
    .all(...params)
    .map((step) => (step as { detail: string }).detail);
};

test("the queries on pending deliveries use the partial index on them", async () => {
  reset();
  const pendingIdx = "webhook_delivery_pending_idx";
  const unfollowed = planOf(unfollowedDeliveries(db, "sub-1", ["p-1"]));
  expect(
    unfollowed.some((s) => s.includes(pendingIdx)),
    unfollowed.join("\n"),
  ).toBe(true);
  const expiry = planOf(expireQuery(db, 0));
  expect(
    expiry.some((s) => s.includes(pendingIdx)),
    expiry.join("\n"),
  ).toBe(true);
  const resume = planOf(
    db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.subscriptionId, "sub-1"), isPending)),
  );
  expect(
    resume.some((s) => s.includes(pendingIdx)),
    resume.join("\n"),
  ).toBe(true);
});
