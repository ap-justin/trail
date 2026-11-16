import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import {
  activityEvent,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import { MESSAGE_TEXT_MAX_BYTES } from "../service/messages.js";
import { projectKey, setupTestApp, testWebhookSettings } from "../test-app.js";
import { createWebhookWorker } from "./worker.js";

const { db, bus, request, addBot, published } = setupTestApp();
type Sent = { url: string; headers: Record<string, string>; body: string };
const sent: Sent[] = [];
const worker = createWebhookWorker({
  db,
  bus,
  settings: testWebhookSettings({
    transport: async ({ url, headers, body }) => {
      sent.push({ url: url.href, headers, body });
      return { status: 204 };
    },
  }),
});

beforeEach(() => {
  sent.length = 0;
});

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;
async function api(key: string, method: string, path: string, json?: unknown) {
  const res = await request(method, `/api/v1${path}`, { key, json });
  expect(
    res.status,
    `${method} ${path}: ${await res.clone().text()}`,
  ).toBeLessThan(300);
  return (await res.json()) as Body;
}

const SECRET = "whsec_inbox_0123456789abcdef";
const verify = ({ headers, body }: Sent) =>
  headers["x-openbot-signature"] ===
  `sha256=${createHmac("sha256", SECRET)
    .update(
      `${headers["x-openbot-timestamp"]}.${headers["x-openbot-delivery-id"]}.${body}`,
    )
    .digest("hex")}`;

let n = 0;
function bots() {
  n++;
  return { alpha: addBot(`alpha-in${n}`), beta: addBot(`beta-in${n}`) };
}

test("an inbox webhook gets each message to its bot, signed, with the whole message", async () => {
  const { alpha, beta } = bots();
  const hook = await api(beta.key, "POST", "/webhooks", {
    kind: "inbox",
    url: `https://beta.example.com/inbox${n}`,
    secret: SECRET,
  });
  expect(hook).toMatchObject({ kind: "inbox", products: [], paused: false });
  const text = "x".repeat(MESSAGE_TEXT_MAX_BYTES);
  const { message } = await api(alpha.key, "POST", "/messages", {
    to: beta.actor.displayName,
    text,
    expectsReply: false,
  });
  await worker.tick();
  expect(sent.map((s) => s.url)).toEqual([
    `https://beta.example.com/inbox${n}`,
  ]);
  const [delivery] = sent as [Sent];
  expect(verify(delivery)).toBe(true);
  expect(JSON.parse(delivery.body)).toEqual({
    type: "trail.message.received",
    occurredAt: message.createdAt,
    data: {
      message: {
        id: message.id,
        from: { id: alpha.actor.id, name: alpha.actor.displayName },
        to: { id: beta.actor.id, name: beta.actor.displayName },
        threadId: message.id,
        replyTo: null,
        expectsReply: false,
        text,
        createdAt: message.createdAt,
      },
    },
  });
});

test("only the recipient's inbox webhook fires: not the sender's, and no activity webhook", async () => {
  const { alpha, beta } = bots();
  const key = projectKey();
  await api(alpha.key, "POST", "/products", { key, name: `Product ${key}` });
  await api(alpha.key, "POST", "/webhooks", {
    kind: "inbox",
    url: `https://alpha.example.com/inbox${n}`,
    secret: SECRET,
  });
  await api(beta.key, "POST", "/webhooks", {
    products: [key],
    url: `https://beta.example.com/activity${n}`,
    secret: SECRET,
  });
  const inbox = await api(beta.key, "POST", "/webhooks", {
    kind: "inbox",
    url: `https://beta.example.com/inbox${n}`,
    secret: SECRET,
  });
  const events = db.select().from(activityEvent).all().length;
  const publishedBefore = published.length;
  const { message } = await api(alpha.key, "POST", "/messages", {
    to: beta.actor.id,
    text: "hi",
  });
  await worker.tick();
  expect(sent.map((s) => s.url)).toEqual([
    `https://beta.example.com/inbox${n}`,
  ]);
  // no activity event, so nothing for the feed, list_activity or activity webhooks
  expect(db.select().from(activityEvent).all()).toHaveLength(events);
  expect(published).toHaveLength(publishedBefore);
  const activity = await api(beta.key, "GET", "/activity");
  expect(JSON.stringify(activity)).not.toContain("trail.message");
  // queued with the message, for the recipient's inbox webhook alone
  expect(
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.messageId, message.id))
      .all()
      .map((d) => [d.subscriptionId, d.type, d.eventId]),
  ).toEqual([[inbox.id, "trail.message.received", null]]);
  // while a product event does reach the activity webhook
  sent.length = 0;
  await api(alpha.key, "PATCH", `/products/${key}`, { name: "Renamed" });
  await worker.tick();
  expect(sent.map((s) => s.url)).toContain(
    `https://beta.example.com/activity${n}`,
  );
  // the reads the negatives above rest on do move for a real activity event
  expect(db.select().from(activityEvent).all().length).toBeGreaterThan(events);
  expect(published.length).toBeGreaterThan(publishedBefore);
});

test("every inbox webhook of the recipient gets the message, and a paused one waits until it resumes", async () => {
  const { alpha, beta } = bots();
  const urls = ["first", "second", "paused"].map(
    (name) => `https://beta.example.com/${name}${n}`,
  );
  const [first, second, paused] = (await Promise.all(
    urls.map((url) =>
      api(beta.key, "POST", "/webhooks", {
        kind: "inbox",
        url,
        secret: SECRET,
      }),
    ),
  )) as [Body, Body, Body];
  db.update(webhookSubscription)
    .set({ pausedAt: new Date() })
    .where(eq(webhookSubscription.id, paused.id))
    .run();
  const { message } = await api(alpha.key, "POST", "/messages", {
    to: beta.actor.id,
    text: "to all",
  });
  await worker.tick();
  expect(sent.map((s) => s.url).sort()).toEqual([urls[0], urls[1]].sort());
  expect(
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.messageId, message.id))
      .all()
      .map((d) => [d.subscriptionId, d.status])
      .sort(),
  ).toEqual(
    [
      [first.id, "delivered"],
      [second.id, "delivered"],
      [paused.id, "pending"],
    ].sort(),
  );

  // an update, even with no fields, resumes it, and the message it missed goes out
  sent.length = 0;
  await api(beta.key, "PATCH", `/webhooks/${paused.id}`, {});
  await worker.tick();
  expect(sent.map((s) => s.url)).toEqual([urls[2]]);
  expect(JSON.parse((sent[0] as Sent).body).data.message.id).toBe(message.id);
});

test("an inbox webhook takes no products, and an activity webhook can't be made without them", async () => {
  const { alpha } = bots();
  const key = projectKey();
  await api(alpha.key, "POST", "/products", { key, name: `Product ${key}` });
  const withProducts = await request("POST", "/api/v1/webhooks", {
    key: alpha.key,
    json: {
      kind: "inbox",
      products: [key],
      url: "https://alpha.example.com/mixed",
      secret: SECRET,
    },
  });
  expect(withProducts.status).toBe(422);
  expect(((await withProducts.json()) as Body).error.message).toMatch(
    "an inbox webhook follows no products",
  );
  const hook = await api(alpha.key, "POST", "/webhooks", {
    kind: "inbox",
    url: "https://alpha.example.com/inbox-only",
    secret: SECRET,
  });
  const patched = await request("PATCH", `/api/v1/webhooks/${hook.id}`, {
    key: alpha.key,
    json: { products: [key] },
  });
  expect(patched.status).toBe(422);
  const bare = await request("POST", "/api/v1/webhooks", {
    key: alpha.key,
    json: { url: "https://alpha.example.com/bare", secret: SECRET },
  });
  expect(((await bare.json()) as Body).error.message).toMatch(
    "or send kind inbox for the messages other bots send you",
  );
});
