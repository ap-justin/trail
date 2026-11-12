import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import {
  activityEvent,
  project,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import { projectKey, setupTestApp, testWebhookSettings } from "../test-app.js";
import { buildEnvelope } from "../webhooks/payload.js";
import { createWebhookWorker } from "../webhooks/worker.js";

// the app and the worker share one clock that stands still until a test moves it
let clock = Date.now();
const now = () => clock;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const { db, bus, app, bot, request, published, addBot } = setupTestApp({
  webhooks: { now },
});
const sent: string[] = [];
let answer = 503;
const worker = () =>
  createWebhookWorker({
    db,
    bus,
    settings: testWebhookSettings({
      now,
      transport: async ({ body }) => {
        sent.push(body);
        return { status: answer };
      },
    }),
    backoffMs: [MINUTE],
    pauseAfter: 1000,
  });

beforeEach(() => {
  db.delete(webhookSubscription).run();
  sent.length = 0;
  answer = 503;
  clock = Date.now();
});

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
const subscribe = (projects: string[], url: string) =>
  api("POST", "/webhooks", {
    url,
    secret: "whsec_service_0123456789abcdef",
    projects,
  });
/** Files an issue at the current clock; its delivery's retry window starts then. */
async function fileIssue(key: string, title: string) {
  await api("POST", "/issues", { projectId: key, title });
  db.update(webhookDelivery)
    .set({ createdAt: new Date(clock) })
    .where(eq(webhookDelivery.seq, maxSeq()))
    .run();
}
const maxSeq = () =>
  Math.max(
    ...db
      .select()
      .from(webhookDelivery)
      .all()
      .map((d) => d.seq),
  );
const pause = (id: string) =>
  db
    .update(webhookSubscription)
    .set({ pausedAt: new Date(clock), consecutiveFailures: 8 })
    .where(eq(webhookSubscription.id, id))
    .run();
/** Each delivery's status, in event order. */
const statuses = () =>
  db
    .select({ status: webhookDelivery.status })
    .from(webhookDelivery)
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => d.status);

test("a resume gives back the paused time each delivery waited through, not the whole pause", async () => {
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/window");
  await fileIssue(key, "before");
  clock += 2 * HOUR;
  pause(hook.id);
  clock += 7 * DAY - HOUR;
  await fileIssue(key, "during");
  clock += HOUR;
  const resumedAt = clock;
  await api("PATCH", `/webhooks/${hook.id}`, {});
  const w = worker();

  // "before" lived 2 hours of its window ahead of the pause, so 22 are left
  clock = resumedAt + 21 * HOUR;
  await w.tick();
  expect(statuses()).toEqual(["pending", "pending"]);
  clock = resumedAt + 22 * HOUR + MINUTE;
  await w.tick();
  expect(statuses()).toEqual(["failed", "pending"]);
  // "during" was queued inside the pause, so its whole 24 hours start at the resume
  clock = resumedAt + 24 * HOUR + MINUTE;
  await w.tick();
  expect(statuses()).toEqual(["failed", "failed"]);
});

test("updating or rotating a webhook that isn't paused leaves its retry's backoff alone", async () => {
  const key = await newProject();
  const hook = await subscribe([key], "https://bot.example.com/backoff");
  await fileIssue(key, "retrying");
  const w = worker();
  await w.tick();
  expect(sent).toHaveLength(1);

  // the one-minute backoff is running; neither change may cut it short
  clock += 10_000;
  await api("PATCH", `/webhooks/${hook.id}`, { projects: [key] });
  await w.tick();
  await api("PUT", `/webhooks/${hook.id}/secret`, {
    secret: "whsec_service_rotated_0123456789",
  });
  await w.tick();
  expect(sent).toHaveLength(1);

  clock += MINUTE;
  await w.tick();
  expect(sent).toHaveLength(2);
});

test("a create replayed under its idempotency key queues no second delivery", async () => {
  const key = await newProject();
  await subscribe([key], "https://bot.example.com/replay");
  const post = () =>
    app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bot.key}`,
        "content-type": "application/json",
        "idempotency-key": "replay-once",
      },
      body: JSON.stringify({ projectId: key, title: "once" }),
    });
  const first = await post();
  const again = await post();
  expect(first.status).toBe(201);
  const [made, replayed] = (await Promise.all([
    first.json(),
    again.json(),
  ])) as Body[];
  expect(replayed?.id).toBe(made?.id);
  expect(statuses()).toEqual(["pending"]);
});

test("a label, a status update and a project change each describe their project", async () => {
  const PUBLIC = "https://trail.example";
  const key = await newProject();
  const since = published.length;
  await api("POST", `/projects/${key}/labels`, { name: "flaky" });
  await api("POST", `/projects/${key}/status-updates`, {
    body: "shipping friday",
    health: "on_track",
  });
  await api("PATCH", `/projects/${key}`, { name: "Renamed" });
  const subjects = published
    .slice(since)
    .map((event) => buildEnvelope(db, event, PUBLIC).data as Body)
    .map(({ subject, url }) => ({
      type: subject.type,
      key: subject.key,
      title: subject.title,
      url,
    }));
  const url = `${PUBLIC}/projects/${key}`;
  expect(subjects).toEqual([
    { type: "label", key, title: "flaky", url },
    { type: "status_update", key, title: "Status update: on_track", url },
    { type: "project", key, title: "Renamed", url },
  ]);
});

test("a webhook on two projects gets their events in the order they happened, around another bot's writes", async () => {
  answer = 200;
  const p = await newProject();
  const q = await newProject();
  await subscribe([p, q], "https://bot.example.com/two-projects");
  const other = addBot("interleaver");
  const asOther = async (title: string, projectId: string) => {
    const res = await request("POST", "/api/v1/issues", {
      json: { projectId, title },
      key: other.key,
    });
    expect(res.status).toBe(201);
  };
  const otherProject = projectKey();
  expect(
    (
      await request("POST", "/api/v1/projects", {
        json: { key: otherProject, name: "Elsewhere" },
        key: other.key,
      })
    ).status,
  ).toBe(201);

  await api("POST", "/issues", { projectId: q, title: "q1" });
  await asOther("x1", otherProject);
  await api("POST", "/issues", { projectId: p, title: "p1" });
  await asOther("x2", otherProject);
  await api("POST", "/issues", { projectId: q, title: "q2" });

  const w = worker();
  for (let i = 0; i < 10 && sent.length < 3; i++) await w.tick();
  expect(
    sent.map((body) => JSON.parse(body).data.subject.title as string),
  ).toEqual(["q1", "p1", "q2"]);
});

test("a ping to a webhook whose stored secret can't be read says to rotate it, and sends nothing", async () => {
  const key = await newProject();
  const hook = await api("POST", "/webhooks", {
    url: "https://bot.example.com/unreadable",
    secret: "whsec_unreadable_0123456789",
    projects: [key],
  });
  // as after BETTER_AUTH_SECRET changes: the ciphertext no longer opens
  db.update(webhookSubscription)
    .set({ secretCipher: "v1.AAAA.AAAA.AAAA" })
    .where(eq(webhookSubscription.id, hook.id))
    .run();
  const result = await api("POST", `/webhooks/${hook.id}/ping`);
  expect(result).toMatchObject({ delivered: false, status: null });
  expect(result.error).toContain("rotate_webhook_secret");
  expect(sent).toEqual([]);
});

/** Each delivery's project key and status, in event order. */
const deliveriesByProject = () =>
  db
    .select({ key: project.key, status: webhookDelivery.status })
    .from(webhookDelivery)
    .innerJoin(activityEvent, eq(activityEvent.id, webhookDelivery.eventId))
    .innerJoin(project, eq(project.id, activityEvent.projectId))
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => `${d.key}:${d.status}`);

test("dropping a project from a paused webhook drops its backlog for that project, and the resume sends only the rest", async () => {
  const a = await newProject();
  const b = await newProject();
  const hook = await subscribe([a, b], "https://bot.example.com/narrowed");
  await fileIssue(a, "kept");
  await fileIssue(b, "dropped");
  pause(hook.id);

  await api("PATCH", `/webhooks/${hook.id}`, { projects: [a] });
  expect(deliveriesByProject()).toEqual([`${a}:pending`]);

  answer = 200;
  const w = worker();
  await w.tick();
  await w.tick();
  expect(
    sent.map((body) => JSON.parse(body).data.subject.title as string),
  ).toEqual(["kept"]);
});

test("widening a webhook's projects keeps its queued deliveries", async () => {
  const a = await newProject();
  const b = await newProject();
  const hook = await subscribe([a], "https://bot.example.com/widened");
  await fileIssue(a, "queued");

  await api("PATCH", `/webhooks/${hook.id}`, { projects: [a, b] });
  expect(deliveriesByProject()).toEqual([`${a}:pending`]);
});

test("dropping a project keeps the deliveries already made to it", async () => {
  answer = 200;
  const a = await newProject();
  const b = await newProject();
  const hook = await subscribe([a, b], "https://bot.example.com/history");
  await fileIssue(b, "sent before");
  await worker().tick();
  expect(deliveriesByProject()).toEqual([`${b}:delivered`]);

  await api("PATCH", `/webhooks/${hook.id}`, { projects: [a] });
  expect(deliveriesByProject()).toEqual([`${b}:delivered`]);
});
