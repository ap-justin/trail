import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeEach, expect, test } from "vitest";
import { webhookSubscription } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const sent: string[] = [];
const { app, db, bot, addProject, signIn, owner } = setupTestApp({
  webhooks: {
    transport: async ({ url }) => {
      sent.push(url.href);
      return { status: 204 };
    },
  },
});

// biome-ignore lint/suspicious/noExplicitAny: loose tool results for field reads
type Body = Record<string, any>;

const endpoint = new URL("http://trail.test/mcp");
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

async function connect(key: string) {
  const client = new Client({ name: "trail-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: async (url, init) => app.request(String(url), init),
    }),
  );
  clients.push(client);
  return client;
}

const texts: string[] = [];
async function raw(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  texts.push(first?.text ?? "");
  return { isError: result.isError === true, text: first?.text ?? "" };
}
async function call(client: Client, name: string, args: Body = {}) {
  const { isError, text } = await raw(client, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as Body;
}

// each test starts with no webhooks
beforeEach(() => {
  db.delete(webhookSubscription).run();
});

const SECRET = "whsec_mcp_0123456789abcdef";
const NEXT_SECRET = "whsec_mcp_fedcba9876543210";
const a = addProject("A");
const b = addProject("B");

test("a bot manages its webhooks over MCP and the secret never comes back", async () => {
  const client = await connect(bot.key);
  const made = await call(client, "create_webhook", {
    url: "https://bot.example.com/mcp",
    secret: SECRET,
    projects: [a.key],
  });
  expect(made).toMatchObject({ projects: [a.key], paused: false });
  const listed = await call(client, "list_webhooks");
  expect(listed.items.map((w: Body) => w.id)).toEqual([made.id]);
  const moved = await call(client, "update_webhook", {
    webhookId: made.id,
    projects: [a.key, b.key],
  });
  expect(moved.projects).toEqual([a.key, b.key].sort());
  await call(client, "rotate_webhook_secret", {
    webhookId: made.id,
    secret: NEXT_SECRET,
  });
  expect(await call(client, "test_webhook", { webhookId: made.id })).toEqual({
    delivered: true,
    status: 204,
    error: null,
  });
  expect(sent).toEqual(["https://bot.example.com/mcp"]);
  expect(await call(client, "delete_webhook", { webhookId: made.id })).toEqual({
    deleted: true,
  });
  expect((await call(client, "list_webhooks")).items).toEqual([]);
  // a bad secret's refusal doesn't echo it
  const refused = await raw(client, "create_webhook", {
    url: "https://bot.example.com/x",
    secret: "tiny",
    projects: [a.key],
  });
  expect(refused.isError).toBe(true);
  for (const text of texts) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(NEXT_SECRET);
    expect(text).not.toContain("tiny");
  }
});

test("another bot's webhook, a hidden project and an internal URL are refused", async () => {
  const owner = await connect(bot.key);
  const mine = await call(owner, "create_webhook", {
    url: "https://bot.example.com/owner",
    secret: SECRET,
    projects: [a.key],
  });
  const other = await connect(createBot(db, "other-bot").key);
  for (const [tool, args] of [
    ["update_webhook", { projects: [a.key] }],
    ["rotate_webhook_secret", { secret: NEXT_SECRET }],
    ["delete_webhook", {}],
    ["test_webhook", {}],
  ] as const) {
    const res = await raw(other, tool, { webhookId: mine.id, ...args });
    expect(res.isError, tool).toBe(true);
    expect(res.text, tool).toMatch(/^not_found:/);
  }
  expect((await call(other, "list_webhooks")).items).toEqual([]);

  const scoped = await connect(
    createBot(db, "scoped-bot", {
      scope: { projects: [a.key], actions: ["read"] },
    }).key,
  );
  const hidden = await raw(scoped, "create_webhook", {
    url: "https://bot.example.com/scoped",
    secret: SECRET,
    projects: [b.key],
  });
  expect(hidden.text).toMatch(/^not_found: no project/);
  const internal = await raw(scoped, "create_webhook", {
    url: "https://10.0.0.1/hook",
    secret: SECRET,
    projects: [a.key],
  });
  expect(internal.text).toMatch(/^validation_failed:.*internal address/);
  const insecure = await raw(scoped, "create_webhook", {
    url: "http://bot.example.com/hook",
    secret: SECRET,
    projects: [a.key],
  });
  expect(insecure.text).toMatch(/^validation_failed:.*https/);
});

test("the tool descriptions walk a bot through hooking up an OpenBot routine", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  const create = tools.find((t) => t.name === "create_webhook")?.description;
  expect(create).toContain("OpenBot webhook routine");
  expect(create).toContain("Never paste the secret into chat");
  expect(create).toContain("test_webhook");
  expect(create).toContain("x-openbot-signature");
  for (const name of ["create_webhook", "rotate_webhook_secret"]) {
    const tool = tools.find((t) => t.name === name);
    expect(JSON.stringify(tool?.inputSchema)).toContain("never");
  }
});

test("a signed-in person gets no MCP tools: every webhook call is a 401 and changes nothing", async () => {
  const client = await connect(bot.key);
  const mine = await call(client, "create_webhook", {
    url: "https://bot.example.com/person",
    secret: SECRET,
    projects: [a.key],
  });
  const cookie = await signIn(owner);
  sent.length = 0;
  for (const [name, args] of [
    [
      "create_webhook",
      { url: "https://bot.example.com/p2", secret: SECRET, projects: [a.key] },
    ],
    ["list_webhooks", {}],
    ["update_webhook", { webhookId: mine.id, projects: [b.key] }],
    ["rotate_webhook_secret", { webhookId: mine.id, secret: NEXT_SECRET }],
    ["test_webhook", { webhookId: mine.id }],
    ["delete_webhook", { webhookId: mine.id }],
  ] as const) {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status, name).toBe(401);
  }
  expect(sent).toEqual([]);
  const after = await call(client, "list_webhooks");
  expect(after.items).toHaveLength(1);
  expect(after.items[0]).toMatchObject({
    id: mine.id,
    url: "https://bot.example.com/person",
    projects: [a.key],
  });
});
