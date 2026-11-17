import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { webhookDelivery, webhookSubscription } from "../db/schema.js";
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

  const revoked =
    "not sent: this webhook's key is revoked: update the webhook (update_webhook) or rotate its secret with a live key to get deliveries again";
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
    ["failed", revoked],
    ["failed", revoked],
    ["failed", revoked],
    ["failed", revoked],
  ]);

  const rotated = await connect(
    createKey(db, made.actor.id, { actions: ["read"] }).key,
  );
  const [listed] = (await call(rotated, "list_webhooks")).items as Body[];
  expect(listed).toMatchObject({
    id: webhook.id,
    paused: false,
    consecutiveFailures: 0,
    lastError: revoked,
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
    [
      "failed",
      "not sent: this bot has no live key: update the webhook (update_webhook) or rotate its secret with a live key to get deliveries again",
    ],
    [
      "failed",
      "not sent: this bot has no live key: update the webhook (update_webhook) or rotate its secret with a live key to get deliveries again",
    ],
  ]);
});
