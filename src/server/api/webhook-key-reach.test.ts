import { and, desc, eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import {
  activityEvent,
  apiKey,
  product,
  project,
  projectProduct,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import {
  createBot,
  createKey,
  editKeyScope,
  revokeKey,
} from "../service/keys.js";
import { setupTestApp, testWebhookSettings } from "../test-app.js";
import { createWebhookWorker } from "../webhooks/worker.js";

const sent: string[] = [];
const { db, bus, request } = setupTestApp();
const worker = createWebhookWorker({
  db,
  bus,
  settings: testWebhookSettings({
    transport: async ({ url }) => {
      sent.push(url.href);
      return { status: 204 };
    },
  }),
});

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

async function call(method: string, path: string, key?: string, json?: Body) {
  const res = await request(method, `/api/v1${path}`, { json, key });
  return { status: res.status, body: (await res.json()) as Body };
}
async function ok(method: string, path: string, json?: Body) {
  const res = await call(method, path, undefined, json);
  expect(
    res.status,
    `${method} ${path}: ${JSON.stringify(res.body)}`,
  ).toBeLessThan(300);
  return res.body;
}

let urls = 0;
/** A webhook `key` creates, with its id and URL. */
async function follow(json: Body, key: string) {
  const made = await call("POST", "/webhooks", key, {
    url: `https://bot.example.com/key-reach/${++urls}`,
    secret: "whsec_key_reach_0123456789abcdef",
    ...json,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body as { id: string; url: string };
}

/** A subscription's deliveries in queue order, as [type, status, attempts, lastError]. */
const historyOf = (subscriptionId: string) =>
  db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, subscriptionId))
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => [d.type, d.status, d.attempts, d.lastError]);

/** How many deliveries the worker sends to `url` on its next pass. */
async function sentNowTo(url: string) {
  sent.length = 0;
  await worker.tick();
  return sent.filter((u) => u === url).length;
}

const prefixOf = (key: string) => key.slice(6, 14);

// the lastError of each delivery refused for its key, as a bot reads it
const KEY_REVOKED =
  "not sent: this webhook's key is revoked: update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with a live key (with the read action, on an activity webhook) to get deliveries again";
const NO_LIVE_KEY =
  "not sent: this bot has no live key: a key must be minted for it first (trail key create), then update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with that key (with the read action, on an activity webhook) to get deliveries again";
const KEY_CANNOT_READ =
  "not sent: this webhook's key lacks the read action: update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with a key that has the read action to get deliveries again";
const NO_KEY_CAN_READ =
  "not sent: none of this bot's live keys has the read action: update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with a key that has the read action to get deliveries again";

// products ATL and BTA; project recon draws from both
await ok("POST", "/products", { key: "ATL", name: "Alpha product" });
await ok("POST", "/products", { key: "BTA", name: "Beta product" });
const todo = async (product: string, title: string) =>
  (await ok("POST", "/items", { type: "todo", product, title })).key as string;
const atl = await todo("ATL", "atl item");
await ok("POST", "/projects", {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
// solo draws from ATL alone, holding one ATL item
await ok("POST", "/projects", {
  name: "Solo",
  slug: "solo",
  products: ["ATL"],
});
const soloItem = await todo("ATL", "atl in solo");
await ok("POST", "/projects/solo/items", { items: [soloItem] });
const retitle = (key: string, title: string) =>
  ok("PATCH", `/items/${key}`, { title });

let bots = 0;
const botWith = (scope: { products?: string[]; projects?: string[] }) =>
  createBot(db, `reach-${++bots}`, {
    scope: { ...scope, actions: ["read"] },
  }).key;

beforeEach(async () => {
  await worker.tick();
  db.delete(webhookSubscription).run();
});

test("revoking the key that made a webhook skips its queued deliveries and those after, each marked with the reason", async () => {
  const { actor, key } = createBot(db, `reach-${++bots}`, {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  const { id, url } = await follow({ products: ["ATL"] }, key);
  await retitle(atl, "queued before the revoke");
  revokeKey(db, prefixOf(key));
  await retitle(atl, "after the revoke");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id)).toEqual([
    ["trail.issue.updated", "failed", 0, KEY_REVOKED],
    ["trail.item.updated", "failed", 0, KEY_REVOKED],
    ["trail.issue.updated", "failed", 0, KEY_REVOKED],
    ["trail.item.updated", "failed", 0, KEY_REVOKED],
  ]);
  // a skip is not the receiver's failure: it names itself on the webhook but counts toward no pause
  const rotated = createKey(db, actor.id, { actions: ["read"] }).key;
  const read = await call("GET", `/webhooks/${id}`, rotated);
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({
    paused: false,
    consecutiveFailures: 0,
    lastError: KEY_REVOKED,
  });
  expect(read.body.lastErrorAt).toEqual(expect.any(String));
});

test("a project taken off the key skips the deliveries of a webhook following it, naming the project", async () => {
  const key = botWith({ products: ["BTA"], projects: ["solo"] });
  const { id, url } = await follow({ projects: ["solo"] }, key);
  await retitle(soloItem, "queued while the key had solo");
  expect(await sentNowTo(url)).toBe(2);
  await retitle(soloItem, "queued before the edit");
  editKeyScope(db, prefixOf(key), { removeProjects: ["solo"] });
  expect(await sentNowTo(url)).toBe(0);
  const lost = "not sent: this webhook's key no longer reaches solo";
  expect(historyOf(id).slice(2)).toEqual([
    ["trail.issue.updated", "failed", 0, lost],
    ["trail.item.updated", "failed", 0, lost],
  ]);
});

test("a product taken off the key skips the deliveries of a webhook following it, naming the product", async () => {
  const key = botWith({ products: ["ATL", "BTA"] });
  const { id, url } = await follow({ products: ["ATL"] }, key);
  await retitle(atl, "queued while the key had ATL");
  expect(await sentNowTo(url)).toBe(2);
  await retitle(atl, "queued before the edit");
  editKeyScope(db, prefixOf(key), { removeProducts: ["ATL"] });
  expect(await sentNowTo(url)).toBe(0);
  const lost = "not sent: this webhook's key no longer reaches ATL";
  expect(historyOf(id).slice(2)).toEqual([
    ["trail.issue.updated", "failed", 0, lost],
    ["trail.item.updated", "failed", 0, lost],
  ]);
});

test("a key that read a project through its product skips the webhook following it once the product leaves the project", async () => {
  await ok("POST", "/projects", {
    name: "Joint",
    slug: "joint",
    products: ["ATL", "BTA"],
  });
  const atlInJoint = await todo("ATL", "atl in joint");
  await ok("POST", "/projects/joint/items", { items: [atlInJoint] });
  const key = botWith({ products: ["BTA"] });
  const { id, url } = await follow({ projects: ["joint"] }, key);
  await retitle(atlInJoint, "read through BTA");
  expect(await sentNowTo(url)).toBe(2);
  await retitle(atlInJoint, "queued before BTA left");
  // no route takes a product out of a project
  const joint = db
    .select()
    .from(project)
    .where(eq(project.slug, "joint"))
    .get();
  const bta = db.select().from(product).where(eq(product.key, "BTA")).get();
  db.delete(projectProduct)
    .where(
      and(
        eq(projectProduct.projectId, joint?.id ?? ""),
        eq(projectProduct.productId, bta?.id ?? ""),
      ),
    )
    .run();
  expect(await sentNowTo(url)).toBe(0);
  const lost = "not sent: this webhook's key no longer reaches joint";
  expect(historyOf(id).slice(2)).toEqual([
    ["trail.issue.updated", "failed", 0, lost],
    ["trail.item.updated", "failed", 0, lost],
  ]);
});

test("a key listing only a project gets that project's deliveries and none outside it, and none once the project leaves its scope", async () => {
  const key = botWith({ projects: ["solo"] });
  const { id, url } = await follow({ projects: ["solo"] }, key);
  await retitle(soloItem, "read through solo alone");
  expect(await sentNowTo(url)).toBe(2);
  expect(historyOf(id).every(([, status]) => status === "delivered")).toBe(
    true,
  );
  // an event outside solo, of a product the key lists none of, is never queued for it
  await retitle(atl, "outside solo");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id)).toHaveLength(2);
  await retitle(soloItem, "queued before the edit");
  editKeyScope(db, prefixOf(key), {
    removeProjects: ["solo"],
    addProjects: ["recon"],
  });
  expect(await sentNowTo(url)).toBe(0);
  const lost = "not sent: this webhook's key no longer reaches solo";
  expect(historyOf(id).slice(2)).toEqual([
    ["trail.issue.updated", "failed", 0, lost],
    ["trail.item.updated", "failed", 0, lost],
  ]);
});

test("a key whose scope still reaches what its webhook follows gets every delivery", async () => {
  const key = botWith({ products: ["ATL"], projects: ["solo"] });
  const { id, url } = await follow(
    { products: ["ATL"], projects: ["solo"] },
    key,
  );
  editKeyScope(db, prefixOf(key), { addProducts: ["BTA"] });
  await retitle(atl, "still reached");
  expect(await sentNowTo(url)).toBe(2);
  expect(historyOf(id).every(([, status]) => status === "delivered")).toBe(
    true,
  );
});

test("an unrestricted key's webhook is delivered until the key is revoked", async () => {
  const key = createBot(db, "reach-unrestricted").key;
  const { url } = await follow({ products: ["ATL"] }, key);
  await retitle(atl, "unrestricted");
  expect(await sentNowTo(url)).toBe(2);
  revokeKey(db, prefixOf(key));
  await retitle(atl, "unrestricted, revoked");
  expect(await sentNowTo(url)).toBe(0);
});

/** Clears the recorded key, as on a webhook made before keys were recorded. */
const forgetKey = (subscriptionId: string) =>
  db
    .update(webhookSubscription)
    .set({ apiKeyId: null })
    .where(eq(webhookSubscription.id, subscriptionId))
    .run();

test("a webhook with no recorded key is delivered while its bot's live key reaches it, and skipped once every key is revoked", async () => {
  const key = botWith({ products: ["ATL"] });
  const { id, url } = await follow({ products: ["ATL"] }, key);
  forgetKey(id);
  await retitle(atl, "checked against the bot's live key");
  expect(await sentNowTo(url)).toBe(2);
  revokeKey(db, prefixOf(key));
  await retitle(atl, "no live key");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id).slice(2)).toEqual([
    ["trail.issue.updated", "failed", 0, NO_LIVE_KEY],
    ["trail.item.updated", "failed", 0, NO_LIVE_KEY],
  ]);
  expect(
    db
      .select()
      .from(webhookSubscription)
      .where(eq(webhookSubscription.id, id))
      .get(),
  ).toMatchObject({
    consecutiveFailures: 0,
    lastError: NO_LIVE_KEY,
    lastErrorAt: expect.any(Date),
    pausedAt: null,
  });
});

const sender = createBot(db, "reach-sender").key;
/** Sends `to` a direct message from another bot. */
async function message(to: string, text: string) {
  const sent = await call("POST", "/messages", sender, {
    to,
    text,
    expectsReply: false,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
}

test("an inbox webhook gets its messages while the key that made it lives, and skips them once it is revoked", async () => {
  const receiver = createBot(db, "reach-inbox", {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  const { id, url } = await follow({ kind: "inbox" }, receiver.key);
  await message(receiver.actor.displayName, "delivered");
  expect(await sentNowTo(url)).toBe(1);
  revokeKey(db, prefixOf(receiver.key));
  await message(receiver.actor.displayName, "after the revoke");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id)).toEqual([
    ["trail.message.received", "delivered", 1, null],
    ["trail.message.received", "failed", 0, KEY_REVOKED],
  ]);
  expect(
    db
      .select()
      .from(webhookSubscription)
      .where(eq(webhookSubscription.id, id))
      .get(),
  ).toMatchObject({
    consecutiveFailures: 0,
    lastError: KEY_REVOKED,
    lastErrorAt: expect.any(Date),
    pausedAt: null,
  });
});

test("an inbox webhook made by one key is still delivered after the bot's other key is revoked", async () => {
  const receiver = createBot(db, "reach-inbox-two", {
    scope: { actions: ["read"] },
  });
  const other = createKey(db, receiver.actor.id, { actions: ["read"] }).key;
  const { url } = await follow({ kind: "inbox" }, receiver.key);
  revokeKey(db, prefixOf(other));
  await message(receiver.actor.displayName, "maker still live");
  expect(await sentNowTo(url)).toBe(1);
});

test("a webhook with no recorded key is delivered while a second live key reaches it after the first is revoked", async () => {
  const first = createBot(db, `reach-${++bots}`, {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  const second = createKey(db, first.actor.id, {
    products: ["ATL"],
    actions: ["read"],
  }).key;
  const { id, url } = await follow({ products: ["ATL"] }, first.key);
  forgetKey(id);
  revokeKey(db, prefixOf(first.key));
  await retitle(atl, "the second key still reaches ATL");
  expect(await sentNowTo(url)).toBe(2);
  revokeKey(db, prefixOf(second));
  await retitle(atl, "both revoked");
  expect(await sentNowTo(url)).toBe(0);
});

test("a webhook with no recorded key goes out when any one of its bot's keys reaches it, and is skipped with the oldest key's reason when none does", async () => {
  const older = createBot(db, `reach-${++bots}`, {
    scope: { products: ["ATL", "BTA"], actions: ["read"] },
  });
  const newer = createKey(db, older.actor.id, {
    products: ["ATL", "BTA"],
    actions: ["read"],
  }).key;
  // key ages tie within a clock tick: pin which is the oldest
  db.update(apiKey)
    .set({ createdAt: new Date(Date.now() - 3_600_000) })
    .where(eq(apiKey.prefix, prefixOf(older.key)))
    .run();
  const { id, url } = await follow({ products: ["ATL", "BTA"] }, newer);
  forgetKey(id);
  editKeyScope(db, prefixOf(older.key), { removeProducts: ["BTA"] });
  await retitle(atl, "the newer key reaches both products");
  expect(await sentNowTo(url)).toBe(2);
  editKeyScope(db, prefixOf(newer), { removeProducts: ["ATL"] });
  await retitle(atl, "neither key reaches both products");
  expect(await sentNowTo(url)).toBe(0);
  // the older key lost BTA and the newer lost ATL: only the older's reason is recorded
  const lost = "not sent: this webhook's key no longer reaches BTA";
  expect(historyOf(id).slice(2)).toEqual([
    ["trail.issue.updated", "failed", 0, lost],
    ["trail.item.updated", "failed", 0, lost],
  ]);
});

test("a project-following webhook with no recorded key goes out when any one of its bot's keys reaches the project, and is skipped naming the project when none does", async () => {
  const older = createBot(db, `reach-${++bots}`, {
    scope: { projects: ["solo"], actions: ["read"] },
  });
  const newer = createKey(db, older.actor.id, {
    projects: ["solo"],
    actions: ["read"],
  }).key;
  // key ages tie within a clock tick: pin which is the oldest
  db.update(apiKey)
    .set({ createdAt: new Date(Date.now() - 3_600_000) })
    .where(eq(apiKey.prefix, prefixOf(older.key)))
    .run();
  const { id, url } = await follow({ projects: ["solo"] }, newer);
  forgetKey(id);
  editKeyScope(db, prefixOf(older.key), {
    removeProjects: ["solo"],
    addProjects: ["recon"],
  });
  await retitle(soloItem, "the newer key still reaches solo");
  expect(await sentNowTo(url)).toBe(2);
  editKeyScope(db, prefixOf(newer), {
    removeProjects: ["solo"],
    addProjects: ["recon"],
  });
  await retitle(soloItem, "neither key reaches solo");
  expect(await sentNowTo(url)).toBe(0);
  const lost = "not sent: this webhook's key no longer reaches solo";
  expect(historyOf(id)).toEqual([
    ["trail.issue.updated", "delivered", 1, null],
    ["trail.item.updated", "delivered", 1, null],
    ["trail.issue.updated", "failed", 0, lost],
    ["trail.item.updated", "failed", 0, lost],
  ]);
});

test("an inbox webhook with no recorded key gets its messages while its bot has a live key, and skips them once it has none", async () => {
  const receiver = createBot(db, "reach-inbox-unrecorded", {
    scope: { actions: ["read"] },
  });
  const { id, url } = await follow({ kind: "inbox" }, receiver.key);
  forgetKey(id);
  await message(receiver.actor.displayName, "a live key");
  expect(await sentNowTo(url)).toBe(1);
  revokeKey(db, prefixOf(receiver.key));
  await message(receiver.actor.displayName, "no live key");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id)).toEqual([
    ["trail.message.received", "delivered", 1, null],
    ["trail.message.received", "failed", 0, NO_LIVE_KEY],
  ]);
});

test("an activity webhook with no recorded key is skipped while none of its bot's live keys has the read action, and delivered once one does", async () => {
  const a = createBot(db, `reach-${++bots}`, {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  createKey(db, a.actor.id, { products: ["ATL"], actions: ["issues"] });
  const { id, url } = await follow({ products: ["ATL"] }, a.key);
  forgetKey(id);
  revokeKey(db, prefixOf(a.key));
  await retitle(atl, "the live key can't read");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id)).toEqual([
    ["trail.issue.updated", "failed", 0, NO_KEY_CAN_READ],
    ["trail.item.updated", "failed", 0, NO_KEY_CAN_READ],
  ]);
  createKey(db, a.actor.id, { products: ["ATL"], actions: ["read"] });
  await retitle(atl, "a live key reads");
  expect(await sentNowTo(url)).toBe(2);
});

test("an activity webhook whose recorded key lacks the read action is skipped naming that", async () => {
  const maker = createBot(db, `reach-${++bots}`, {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  const unread = createKey(db, maker.actor.id, {
    products: ["ATL"],
    actions: ["issues"],
  }).key;
  const { id, url } = await follow({ products: ["ATL"] }, maker.key);
  // as migration 0019 recorded a bot's only live key, whatever its actions
  const unreadId = db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(eq(apiKey.prefix, prefixOf(unread)))
    .get()?.id;
  db.update(webhookSubscription)
    .set({ apiKeyId: unreadId })
    .where(eq(webhookSubscription.id, id))
    .run();
  await retitle(atl, "recorded key can't read");
  expect(await sentNowTo(url)).toBe(0);
  expect(historyOf(id)).toEqual([
    ["trail.issue.updated", "failed", 0, KEY_CANNOT_READ],
    ["trail.item.updated", "failed", 0, KEY_CANNOT_READ],
  ]);
});

test("an inbox webhook with no recorded key gets its messages while its bot's only live key lacks the read action", async () => {
  const receiver = createBot(db, "reach-inbox-unread", {
    scope: { actions: ["read"] },
  });
  createKey(db, receiver.actor.id, { actions: ["comments"] });
  const { url, id } = await follow({ kind: "inbox" }, receiver.key);
  forgetKey(id);
  revokeKey(db, prefixOf(receiver.key));
  await message(receiver.actor.displayName, "inbox needs no read");
  expect(await sentNowTo(url)).toBe(1);
});

test("a delivery of an event outside the key's reach is skipped naming its product while the followed product's is sent", async () => {
  const key = botWith({ products: ["ATL"] });
  const { id, url } = await follow({ products: ["ATL"] }, key);
  // a product's own event: the worker's left-the-project check passes it over
  const eventOf = async (product: string) => {
    const updated = await ok("PATCH", `/products/${product}`, {
      description: `described ${++urls}`,
    });
    return db
      .select()
      .from(activityEvent)
      .where(
        and(
          eq(activityEvent.subjectId, updated.id),
          eq(activityEvent.action, "product.updated"),
        ),
      )
      .orderBy(desc(activityEvent.seq))
      .get() as typeof activityEvent.$inferSelect;
  };
  const reached = await eventOf("ATL");
  const outside = await eventOf("BTA");
  // the subscription follows ATL alone, so no event of BTA is ever queued for it
  db.insert(webhookDelivery)
    .values({
      subscriptionId: id,
      eventId: outside.id,
      seq: outside.seq,
      type: "trail.product.updated",
      nextAttemptAt: new Date(),
    })
    .run();
  expect(await sentNowTo(url)).toBe(2);
  const outcomes = db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, id))
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => [d.eventId, d.status, d.lastError]);
  expect(outcomes).toEqual([
    [reached.id, "delivered", null],
    [reached.id, "delivered", null],
    [
      outside.id,
      "failed",
      "not sent: this webhook's key no longer reaches BTA",
    ],
  ]);
});
