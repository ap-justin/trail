import { expect, test } from "vitest";
import { productMember } from "../db/schema.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp, testWebhookSettings } from "../test-app.js";
import { createWebhookWorker } from "../webhooks/worker.js";

const delivered: string[] = [];
const { db, bus, bot, request, inviteEmail, signInWithEmail } = setupTestApp();
const worker = createWebhookWorker({
  db,
  bus,
  settings: testWebhookSettings({
    transport: async ({ body }) => {
      delivered.push(body);
      return { status: 204 };
    },
  }),
});

const ADDRESS = "Justin.Sweep@example.com";
const handlerInvite = inviteEmail(ADDRESS.toLowerCase());
await signInWithEmail(ADDRESS.toLowerCase());
const handled = createBot(db, "sweep handled");
const watcher = createBot(db, "sweep watcher");
setBotHandler(db, handled.actor.id, ADDRESS);

async function body(method: string, path: string, key: string, json?: object) {
  const res = await request(method, `/api/v1${path}`, { key, json });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return res.text();
}

test("the handler's email reaches a bot only in its own whoami: never items, comments, lists, activity, webhooks or other bots", async () => {
  const swp = JSON.parse(
    await body("POST", "/products", bot.key, { key: "SWP", name: "sweep" }),
  ) as { id: string };
  // a handler is emailed only about products their invite lists
  db.insert(productMember)
    .values({ inviteId: handlerInvite, productId: swp.id })
    .run();
  await body("POST", "/webhooks", watcher.key, {
    url: "https://bot.example.com/hooks/sweep",
    secret: "whsec_sweep_0123456789abcdef",
    products: ["SWP"],
  });
  const filedText = await body("POST", "/items", handled.key, {
    type: "issue",
    product: "SWP",
    title: "for justin",
    filed_for: "handler",
  });
  const { key } = JSON.parse(filedText) as { key: string };
  const read = [
    filedText,
    await body("POST", `/items/${key}/comments`, handled.key, { body: "hi" }),
    await body("PATCH", `/items/${key}`, bot.key, { status: "canceled" }),
  ];
  for (const k of [handled.key, watcher.key, bot.key]) {
    read.push(
      await body("GET", `/items/${key}`, k),
      await body("GET", "/items?product=SWP&status=canceled", k),
      await body("GET", `/items/${key}/comments`, k),
      await body("GET", "/activity?product=SWP", k),
      await body("GET", "/bots?limit=100", k),
    );
  }
  read.push(
    await body("GET", "/whoami", watcher.key),
    await body("GET", "/whoami", bot.key),
  );
  await worker.tick();
  expect(delivered.length).toBeGreaterThan(0);

  const leaking = [...read, ...delivered].filter((text) =>
    text.toLowerCase().includes(ADDRESS.toLowerCase()),
  );
  expect(leaking).toEqual([]);
  expect((await body("GET", "/whoami", handled.key)).toLowerCase()).toContain(
    ADDRESS.toLowerCase(),
  );
});
