import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { apiKey, webhookDelivery, webhookSubscription } from "../db/schema.js";
import { createBot, createKey, revokeKey } from "../service/keys.js";
import { setupTestApp, testWebhookSettings } from "../test-app.js";
import { createWebhookWorker } from "../webhooks/worker.js";
import { type Body, mcpClients } from "./test-client.js";

const sent: string[] = [];
const { app, db, bus, bot } = setupTestApp();
const { connect, call } = mcpClients(app);
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

// the lastError of each delivery refused for its key, as a bot reads it
const KEY_REVOKED =
  "not sent: this webhook's key is revoked: update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with a live key (with the read action, on an activity webhook) to get deliveries again";
const NO_LIVE_KEY =
  "not sent: this bot has no live key: a key must be minted for it first (trail key create), then update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with that key (with the read action, on an activity webhook) to get deliveries again";
const KEY_CANNOT_READ =
  "not sent: this webhook's key lacks the read action: update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with a key that has the read action to get deliveries again";
const NO_KEY_CAN_READ =
  "not sent: none of this bot's live keys has the read action: update the webhook (update_webhook) or rotate its secret (rotate_webhook_secret) with a key that has the read action to get deliveries again";

async function sentNow() {
  sent.length = 0;
  await worker.tick();
  return sent.length;
}

test("revoking the key that made a webhook over MCP stops its deliveries, each marked with the reason", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_product", { key: "ATL", name: "Alpha" });
  const item = (await call(wide, "add_todo", { product: "ATL", title: "t" }))
    .key as string;
  await worker.tick();

  const made = createBot(db, "mcp-reach", {
    scope: { products: ["ATL"], actions: ["read"] },
  });
  const client = await connect(made.key);
  const webhook = await call(client, "create_webhook", {
    url: "https://bot.example.com/mcp-key-reach",
    secret: "whsec_mcp_key_reach_0123456789",
    products: ["ATL"],
  });

  await call(wide, "update_item", { item, title: "while the key lives" });
  expect(await sentNow()).toBe(2);

  await call(wide, "update_item", { item, title: "queued before the revoke" });
  revokeKey(db, made.key.slice(6, 14));
  await call(wide, "update_item", { item, title: "after the revoke" });
  expect(await sentNow()).toBe(0);

  expect(
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, webhook.id))
      .orderBy(webhookDelivery.seq)
      .all()
      .map((d) => [d.status, d.lastError]),
  ).toEqual([
    ["delivered", null],
    ["delivered", null],
    ["failed", KEY_REVOKED],
    ["failed", KEY_REVOKED],
    ["failed", KEY_REVOKED],
    ["failed", KEY_REVOKED],
  ]);

  const rotated = await connect(
    createKey(db, made.actor.id, { actions: ["read"] }).key,
  );
  const [listed] = (await call(rotated, "list_webhooks")).items as Body[];
  expect(listed).toMatchObject({
    id: webhook.id,
    paused: false,
    consecutiveFailures: 0,
    lastError: KEY_REVOKED,
  });
  expect(listed?.lastErrorAt).toEqual(expect.any(String));
});

test("a webhook made over MCP before keys were recorded is delivered while its bot has a live key, and skipped once it has none", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_product", { key: "OLD", name: "Old" });
  const item = (await call(wide, "add_todo", { product: "OLD", title: "t" }))
    .key as string;
  await worker.tick();

  const made = createBot(db, "mcp-unrecorded", {
    scope: { products: ["OLD"], actions: ["read"] },
  });
  const webhook = await call(await connect(made.key), "create_webhook", {
    url: "https://bot.example.com/mcp-unrecorded",
    secret: "whsec_mcp_unrecorded_0123456789",
    products: ["OLD"],
  });
  // as on a webhook made before keys were recorded
  db.update(webhookSubscription)
    .set({ apiKeyId: null })
    .where(eq(webhookSubscription.id, webhook.id))
    .run();

  await call(wide, "update_item", { item, title: "a live key reaches it" });
  expect(await sentNow()).toBe(2);

  revokeKey(db, made.key.slice(6, 14));
  await call(wide, "update_item", { item, title: "no live key" });
  expect(await sentNow()).toBe(0);
  expect(
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, webhook.id))
      .orderBy(webhookDelivery.seq)
      .all()
      .map((d) => [d.status, d.lastError]),
  ).toEqual([
    ["delivered", null],
    ["delivered", null],
    ["failed", NO_LIVE_KEY],
    ["failed", NO_LIVE_KEY],
  ]);
});

/** A subscription's deliveries in queue order, as [status, lastError]. */
const outcomesOf = (subscriptionId: string) =>
  db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, subscriptionId))
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => [d.status, d.lastError]);

const prefixOf = (key: string) => key.slice(6, 14);

test("an activity webhook made over MCP whose recorded key lacks the read action is skipped naming that", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_product", { key: "RDK", name: "Read key" });
  const item = (await call(wide, "add_todo", { product: "RDK", title: "t" }))
    .key as string;
  await worker.tick();

  const made = createBot(db, "mcp-cannot-read", {
    scope: { products: ["RDK"], actions: ["read"] },
  });
  const unread = createKey(db, made.actor.id, {
    products: ["RDK"],
    actions: ["issues"],
  }).key;
  const webhook = await call(await connect(made.key), "create_webhook", {
    url: "https://bot.example.com/mcp-cannot-read",
    secret: "whsec_mcp_cannot_read_0123456789",
    products: ["RDK"],
  });
  // as migration 0019 recorded a bot's only live key, whatever its actions
  db.update(webhookSubscription)
    .set({
      apiKeyId: db
        .select({ id: apiKey.id })
        .from(apiKey)
        .where(eq(apiKey.prefix, prefixOf(unread)))
        .get()?.id,
    })
    .where(eq(webhookSubscription.id, webhook.id))
    .run();

  await call(wide, "update_item", { item, title: "recorded key can't read" });
  expect(await sentNow()).toBe(0);
  expect(outcomesOf(webhook.id)).toEqual([
    ["failed", KEY_CANNOT_READ],
    ["failed", KEY_CANNOT_READ],
  ]);
});

test("an activity webhook made over MCP with no recorded key is skipped while none of its bot's live keys can read, and delivered once one can", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_product", { key: "RDN", name: "Read none" });
  const item = (await call(wide, "add_todo", { product: "RDN", title: "t" }))
    .key as string;
  await worker.tick();

  const made = createBot(db, "mcp-none-read", {
    scope: { products: ["RDN"], actions: ["read"] },
  });
  createKey(db, made.actor.id, { products: ["RDN"], actions: ["issues"] });
  const webhook = await call(await connect(made.key), "create_webhook", {
    url: "https://bot.example.com/mcp-none-read",
    secret: "whsec_mcp_none_read_0123456789",
    products: ["RDN"],
  });
  db.update(webhookSubscription)
    .set({ apiKeyId: null })
    .where(eq(webhookSubscription.id, webhook.id))
    .run();
  revokeKey(db, prefixOf(made.key));

  await call(wide, "update_item", { item, title: "the live key can't read" });
  expect(await sentNow()).toBe(0);
  expect(outcomesOf(webhook.id)).toEqual([
    ["failed", NO_KEY_CAN_READ],
    ["failed", NO_KEY_CAN_READ],
  ]);

  createKey(db, made.actor.id, { products: ["RDN"], actions: ["read"] });
  await call(wide, "update_item", { item, title: "a live key reads" });
  expect(await sentNow()).toBe(2);
});

test("an inbox webhook made over MCP with no recorded key gets its messages while its bot's only live key lacks the read action", async () => {
  const receiver = createBot(db, "mcp-inbox-unread", {
    scope: { actions: ["read"] },
  });
  createKey(db, receiver.actor.id, { actions: ["comments"] });
  const webhook = await call(await connect(receiver.key), "create_webhook", {
    kind: "inbox",
    url: "https://bot.example.com/mcp-inbox-unread",
    secret: "whsec_mcp_inbox_unread_0123456789",
  });
  db.update(webhookSubscription)
    .set({ apiKeyId: null })
    .where(eq(webhookSubscription.id, webhook.id))
    .run();
  revokeKey(db, prefixOf(receiver.key));

  await call(await connect(bot.key), "message_bot", {
    to: receiver.actor.displayName,
    text: "inbox needs no read",
    expectsReply: false,
  });
  expect(await sentNow()).toBe(1);
  expect(outcomesOf(webhook.id)).toEqual([["delivered", null]]);
});
