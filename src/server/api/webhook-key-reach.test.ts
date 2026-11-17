import { and, eq } from "drizzle-orm";
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
import { createBot, editKeyScope, revokeKey } from "../service/keys.js";
import { keyRefusal } from "../service/webhooks.js";
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
  const key = botWith({ products: ["ATL"] });
  const { id, url } = await follow({ products: ["ATL"] }, key);
  await retitle(atl, "queued before the revoke");
  revokeKey(db, prefixOf(key));
  await retitle(atl, "after the revoke");
  expect(await sentNowTo(url)).toBe(0);
  const revoked = "not sent: the key that made this webhook is revoked";
  expect(historyOf(id)).toEqual([
    ["trail.issue.updated", "failed", 0, revoked],
    ["trail.item.updated", "failed", 0, revoked],
    ["trail.issue.updated", "failed", 0, revoked],
    ["trail.item.updated", "failed", 0, revoked],
  ]);
  // a skip is not the receiver's failure: the webhook stays healthy
  expect(
    db
      .select()
      .from(webhookSubscription)
      .where(eq(webhookSubscription.id, id))
      .get(),
  ).toMatchObject({
    consecutiveFailures: 0,
    lastError: null,
    pausedAt: null,
  });
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
  await retitle(atl, "queued before the edit");
  editKeyScope(db, prefixOf(key), { removeProducts: ["ATL"] });
  expect(await sentNowTo(url)).toBe(0);
  const lost = "not sent: this webhook's key no longer reaches ATL";
  expect(historyOf(id)).toEqual([
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

test("a webhook with no recorded key, as one made before keys were recorded, is delivered after its bot's key is revoked", async () => {
  const key = botWith({ products: ["ATL"] });
  const { id, url } = await follow({ products: ["ATL"] }, key);
  db.update(webhookSubscription)
    .set({ apiKeyId: null })
    .where(eq(webhookSubscription.id, id))
    .run();
  revokeKey(db, prefixOf(key));
  await retitle(atl, "no key to check");
  expect(await sentNowTo(url)).toBe(2);
});

test("an inbox webhook gets its messages after the key that made it is revoked", async () => {
  const receiver = createBot(db, "reach-inbox");
  const sender = createBot(db, "reach-sender");
  const made = await call("POST", "/webhooks", receiver.key, {
    kind: "inbox",
    url: "https://bot.example.com/key-reach/inbox",
    secret: "whsec_key_reach_0123456789abcdef",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  revokeKey(db, prefixOf(receiver.key));
  const message = await call("POST", "/messages", sender.key, {
    to: receiver.actor.displayName,
    text: "still delivered",
    expectsReply: false,
  });
  expect(message.status, JSON.stringify(message.body)).toBe(201);
  expect(await sentNowTo(made.body.url)).toBe(1);
});

test("the check refuses an event the key doesn't reach, naming its product, and passes one it does", async () => {
  const key = botWith({ products: ["ATL"] });
  const { id } = await follow({ products: ["ATL"] }, key);
  const keyId = db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(eq(apiKey.prefix, prefixOf(key)))
    .get()?.id as string;
  const eventOf = (subjectId: string) =>
    db
      .select()
      .from(activityEvent)
      .where(eq(activityEvent.subjectId, subjectId))
      .get() as typeof activityEvent.$inferSelect;
  const itemId = async (product: string) =>
    (await ok("POST", "/items", { type: "todo", product, title: "checked" }))
      .id as string;
  expect(keyRefusal(db, keyId, id, eventOf(await itemId("ATL")))).toBeNull();
  expect(keyRefusal(db, keyId, id, eventOf(await itemId("BTA")))).toBe(
    "not sent: this webhook's key no longer reaches BTA",
  );
});
