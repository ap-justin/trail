import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { app, db, bus, addBot, addProject } = setupTestApp();

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

async function call(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBeFalsy();
  return JSON.parse(first?.text ?? "null") as Body;
}

test("a bot sets its title, trimmed, then clears it, and whoami follows", async () => {
  const mine = await connect(addBot("mcp-titler").key);
  expect(await call(mine, "set_my_title", { title: " Reviewer\n" })).toEqual({
    title: "Reviewer",
  });
  expect((await call(mine, "whoami")).title).toBe("Reviewer");
  expect(await call(mine, "clear_my_title")).toEqual({ title: null });
  expect((await call(mine, "whoami")).title).toBeNull();
});

/** The error text of a call that must fail. */
async function refusal(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBe(true);
  return first?.text ?? "";
}

test("set_my_title keeps 40 characters after trimming and refuses 41, blank and unknown arguments, changing nothing", async () => {
  const mine = await connect(addBot("mcp-lengths").key);
  const forty = "é".repeat(40);
  expect(await call(mine, "set_my_title", { title: ` ${forty} ` })).toEqual({
    title: forty,
  });
  for (const args of [
    { title: "z".repeat(41) },
    { title: "" },
    { title: " \t\n" },
    { title: "Fine", extra: true },
    {},
  ]) {
    expect(await refusal(mine, "set_my_title", args)).toMatch(/title|extra/);
  }
  expect((await call(mine, "whoami")).title).toBe(forty);
});

test("a key limited to reading one project sets and clears its own title, and another bot's stays", async () => {
  const other = await connect(addBot("mcp-bystander").key);
  await call(other, "set_my_title", { title: "Bystander" });
  const reader = await connect(
    createBot(db, "mcp-reader", {
      scope: { projects: [addProject("McpTitleScope").key], actions: ["read"] },
    }).key,
  );
  await call(reader, "set_my_title", { title: "Reader" });
  expect((await call(reader, "whoami")).title).toBe("Reader");
  await call(reader, "clear_my_title");
  expect((await call(reader, "whoami")).title).toBeNull();
  expect((await call(other, "whoami")).title).toBe("Bystander");
});

test("set_my_title without a key is a 401", async () => {
  const res = await app.request(endpoint.href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "set_my_title", arguments: { title: "Anyone" } },
    }),
  });
  expect(res.status).toBe(401);
});

test("the title tools publish a change live and nothing for an unchanged title", async () => {
  const live = addBot("mcp-live");
  const client = await connect(live.key);
  const updates: unknown[] = [];
  const unsubscribe = bus.subscribeActors((update) => updates.push(update));
  try {
    await call(client, "set_my_title", { title: "Live" });
    await call(client, "set_my_title", { title: "Live " });
    await call(client, "clear_my_title");
    await call(client, "clear_my_title");
    expect(updates).toEqual([
      { actorId: live.actor.id, photoUrl: null, title: "Live" },
      { actorId: live.actor.id, photoUrl: null, title: null },
    ]);
  } finally {
    unsubscribe();
  }
});

test("list_bots carries each bot's title, and the tool descriptions say what a title is", async () => {
  const titled = addBot("mcp-listed");
  const client = await connect(titled.key);
  await call(client, "set_my_title", { title: "Listed" });
  const { items } = await call(client, "list_bots", { limit: 200 });
  expect(items.find((b: Body) => b.id === titled.actor.id)?.title).toBe(
    "Listed",
  );
  const { tools } = await client.listTools();
  const describe = (name: string) =>
    tools.find((t) => t.name === name)?.description ?? "";
  expect(describe("set_my_title")).toMatch(/beside your name.*1 to 40/);
  expect(describe("clear_my_title")).toMatch(/title/);
  expect(describe("whoami")).toMatch(/title/);
  expect(describe("list_bots")).toMatch(/title/);
});
