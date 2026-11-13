import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeEach, expect, test } from "vitest";
import { webhookSubscription } from "../db/schema.js";
import { createBot, createKey } from "../service/keys.js";
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

test("update_webhook onto a URL the bot already uses is a conflict that names the twin only to a key that can manage it", async () => {
  const wide = await connect(bot.key);
  const create = (url: string, projects: string[]) =>
    call(wide, "create_webhook", { url, secret: SECRET, projects });
  const both = await create("https://bot.example.com/both", [a.key, b.key]);
  const mine = await create("https://bot.example.com/mine", [a.key]);
  const near = await create("https://bot.example.com/near", [a.key]);

  const onto = await raw(wide, "update_webhook", {
    webhookId: mine.id,
    url: both.url,
  });
  expect(onto.isError).toBe(true);
  expect(onto.text).toMatch(/^conflict: /);
  expect(onto.text).toContain(`webhook ${both.id} already sends to this URL`);

  const narrow = await connect(
    createKey(db, bot.actor.id, { projects: [a.key] }).key,
  );
  // the twin follows B too, which this key can't reach: it is not named
  const hidden = await raw(narrow, "update_webhook", {
    webhookId: mine.id,
    url: both.url,
  });
  expect(hidden.isError).toBe(true);
  expect(hidden.text).toMatch(/^conflict: .*this key can't manage/);
  expect(hidden.text).not.toContain(both.id);
  // one it reaches is named, as to the wide key
  const seen = await raw(narrow, "update_webhook", {
    webhookId: mine.id,
    url: near.url,
  });
  expect(seen.isError).toBe(true);
  expect(seen.text).toContain(`webhook ${near.id} already sends to this URL`);

  // none of the refusals changed the webhook, and its own URL is no conflict
  const listed = await call(wide, "list_webhooks");
  expect(listed.items.find((w: Body) => w.id === mine.id).url).toBe(
    "https://bot.example.com/mine",
  );
  const same = await call(wide, "update_webhook", {
    webhookId: mine.id,
    url: "https://bot.example.com/mine",
  });
  expect(same.url).toBe("https://bot.example.com/mine");
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

test("a key without the read action is refused every webhook tool", async () => {
  const owner = createBot(db, "mcp-writer");
  const full = await connect(owner.key);
  const mine = await call(full, "create_webhook", {
    url: "https://bot.example.com/writer",
    secret: SECRET,
    projects: [a.key],
  });
  const writer = await connect(
    createKey(db, owner.actor.id, { actions: ["issues"] }).key,
  );
  const calls: [string, Body][] = [
    [
      "create_webhook",
      { url: "https://bot.example.com/w", secret: SECRET, projects: [a.key] },
    ],
    ["list_webhooks", {}],
    ["update_webhook", { webhookId: mine.id, projects: [a.key] }],
    ["rotate_webhook_secret", { webhookId: mine.id, secret: NEXT_SECRET }],
    ["delete_webhook", { webhookId: mine.id }],
    ["test_webhook", { webhookId: mine.id }],
  ];
  for (const [tool, args] of calls) {
    const res = await raw(writer, tool, args);
    expect(res.isError, tool).toBe(true);
    expect(res.text, tool).toMatch(/^forbidden_action:/);
  }
});

test("a key narrower than a webhook can't list, change, test or delete it", async () => {
  const owner = createBot(db, "mcp-wide-owner");
  const wide = await connect(owner.key);
  const made = await call(wide, "create_webhook", {
    url: "https://bot.example.com/wide-mcp",
    secret: SECRET,
    projects: [a.key, b.key],
  });
  const narrow = await connect(
    createKey(db, owner.actor.id, { projects: [a.key] }).key,
  );
  expect((await call(narrow, "list_webhooks")).items).toEqual([]);
  for (const [tool, args] of [
    ["update_webhook", { projects: [a.key] }],
    ["rotate_webhook_secret", { secret: NEXT_SECRET }],
    ["delete_webhook", {}],
    ["test_webhook", {}],
  ] as const) {
    const res = await raw(narrow, tool, { webhookId: made.id, ...args });
    expect(res.isError, tool).toBe(true);
    expect(res.text, tool).toMatch(/^not_found:/);
  }
  const dup = await raw(narrow, "create_webhook", {
    url: "https://bot.example.com/wide-mcp",
    secret: SECRET,
    projects: [a.key],
  });
  expect(dup.isError).toBe(true);
  expect(dup.text).not.toContain(made.id);
  // still there for the key that sees it
  expect(
    (await call(wide, "list_webhooks")).items.map((w: Body) => w.id),
  ).toContain(made.id);
});
