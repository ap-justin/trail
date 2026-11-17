import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import { webhookSubscription } from "../db/schema.js";
import { createBot, createKey, revokeKey } from "../service/keys.js";
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
async function ok(method: string, path: string, json?: Body, key?: string) {
  const res = await call(method, path, key, json);
  expect(
    res.status,
    `${method} ${path}: ${JSON.stringify(res.body)}`,
  ).toBeLessThan(300);
  return res.body;
}

const secret = "whsec_key_manager_0123456789abcdef";
let urls = 0;
async function follow(json: Body, key: string) {
  return (await ok(
    "POST",
    "/webhooks",
    { url: `https://bot.example.com/key-manager/${++urls}`, secret, ...json },
    key,
  )) as { id: string; url: string };
}

async function sentNowTo(url: string) {
  sent.length = 0;
  await worker.tick();
  return sent.filter((u) => u === url).length;
}

const prefixOf = (key: string) => key.slice(6, 14);
const keyIdOf = (id: string) =>
  db
    .select({ apiKeyId: webhookSubscription.apiKeyId })
    .from(webhookSubscription)
    .where(eq(webhookSubscription.id, id))
    .get()?.apiKeyId;

await ok("POST", "/products", { key: "ATL", name: "Alpha product" });
await ok("POST", "/products", { key: "BTA", name: "Beta product" });
const atl = (
  await ok("POST", "/items", { type: "todo", product: "ATL", title: "atl" })
).key as string;
const retitle = (title: string) => ok("PATCH", `/items/${atl}`, { title });

let bots = 0;
/** A bot with two read keys: `first` reaching ATL, `second` ATL and BTA. */
function botWithTwoKeys() {
  const first = createBot(db, `manager-${++bots}`, {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  const second = createKey(db, first.actor.id, {
    products: ["ATL", "BTA"],
    actions: ["read"],
  });
  return { bot: first.actor.id, first: first.key, second: second.key };
}

beforeEach(async () => {
  await worker.tick();
  db.delete(webhookSubscription).run();
});

test("an update by a second key moves the check to it: revoking the first still delivers, revoking the second skips", async () => {
  const { first, second } = botWithTwoKeys();
  const { id, url } = await follow({ products: ["ATL"] }, first);
  await ok("PATCH", `/webhooks/${id}`, { products: ["ATL", "BTA"] }, second);
  revokeKey(db, prefixOf(first));
  await retitle("checked against the second key");
  expect(await sentNowTo(url)).toBe(2);
  revokeKey(db, prefixOf(second));
  await retitle("second key revoked");
  expect(await sentNowTo(url)).toBe(0);
});

test("an empty update by a second key moves the check to it too", async () => {
  const { first, second } = botWithTwoKeys();
  const { id, url } = await follow({ products: ["ATL"] }, first);
  await ok("PATCH", `/webhooks/${id}`, {}, second);
  revokeKey(db, prefixOf(first));
  await retitle("empty update");
  expect(await sentNowTo(url)).toBe(2);
});

test("a secret rotation by a second key moves the check to it", async () => {
  const { first, second } = botWithTwoKeys();
  const { id, url } = await follow({ products: ["ATL"] }, first);
  await ok("PUT", `/webhooks/${id}/secret`, { secret }, second);
  revokeKey(db, prefixOf(first));
  await retitle("rotated by the second key");
  expect(await sentNowTo(url)).toBe(2);
  revokeKey(db, prefixOf(second));
  await retitle("rotator revoked");
  expect(await sentNowTo(url)).toBe(0);
});

test("a webhook with no recorded key is checked from its first update on", async () => {
  const { first, second } = botWithTwoKeys();
  const { id, url } = await follow({ products: ["ATL"] }, first);
  db.update(webhookSubscription)
    .set({ apiKeyId: null })
    .where(eq(webhookSubscription.id, id))
    .run();
  await ok("PATCH", `/webhooks/${id}`, {}, second);
  revokeKey(db, prefixOf(second));
  await retitle("checked since the update");
  expect(await sentNowTo(url)).toBe(0);
});

test("a refused update leaves the recorded key as it was", async () => {
  const { bot, first } = botWithTwoKeys();
  const { id } = await follow({ products: ["ATL"] }, first);
  const before = keyIdOf(id);
  const narrow = createKey(db, bot, {
    products: ["ATL"],
    actions: ["read"],
  }).key;
  const refused = await call("PATCH", `/webhooks/${id}`, narrow, {
    products: ["ATL", "BTA"],
  });
  expect(refused.status).toBe(404);
  expect(keyIdOf(id)).toBe(before);
});

test("an inbox webhook records no key when another key updates or rotates it", async () => {
  const { first, second } = botWithTwoKeys();
  const { id } = await follow({ kind: "inbox" }, first);
  const before = keyIdOf(id);
  await ok("PATCH", `/webhooks/${id}`, {}, second);
  await ok("PUT", `/webhooks/${id}/secret`, { secret }, second);
  expect(keyIdOf(id)).toBe(before);
});
