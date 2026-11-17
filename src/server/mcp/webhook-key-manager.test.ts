import { expect, test } from "vitest";
import { createBot, createKey, revokeKey } from "../service/keys.js";
import { setupTestApp, testWebhookSettings } from "../test-app.js";
import { createWebhookWorker } from "../webhooks/worker.js";
import { mcpClients } from "./test-client.js";

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

const prefixOf = (key: string) => key.slice(6, 14);

test("update_webhook and rotate_webhook_secret by a second key move the check to that key", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_product", { key: "ATL", name: "Alpha" });
  const item = (await call(wide, "add_todo", { product: "ATL", title: "t" }))
    .key as string;
  await worker.tick();

  const scope = { products: ["ATL"], actions: ["read" as const] };
  const made = createBot(db, "mcp-manager", { scope });
  const updater = createKey(db, made.actor.id, scope).key;
  const rotator = createKey(db, made.actor.id, scope).key;
  const webhook = await call(await connect(made.key), "create_webhook", {
    url: "https://bot.example.com/mcp-key-manager",
    secret: "whsec_mcp_key_manager_0123456789",
    products: ["ATL"],
  });

  await call(await connect(updater), "update_webhook", {
    webhookId: webhook.id,
  });
  revokeKey(db, prefixOf(made.key));
  await call(wide, "update_item", { item, title: "checked against updater" });
  expect(await sentNow()).toBe(2);

  await call(await connect(rotator), "rotate_webhook_secret", {
    webhookId: webhook.id,
    secret: "whsec_mcp_key_manager_rotated_01",
  });
  revokeKey(db, prefixOf(updater));
  await call(wide, "update_item", { item, title: "checked against rotator" });
  expect(await sentNow()).toBe(2);

  revokeKey(db, prefixOf(rotator));
  await call(wide, "update_item", { item, title: "every key revoked" });
  expect(await sentNow()).toBe(0);
});
