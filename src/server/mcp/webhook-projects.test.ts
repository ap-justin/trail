import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { app, db, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose tool results for field reads
type Body = Record<string, any>;

const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});
async function connect(key: string) {
  const client = new Client({ name: "trail-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://trail.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: async (url, init) => app.request(String(url), init),
    }),
  );
  clients.push(client);
  return client;
}
async function raw(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  return { isError: result.isError === true, text: first?.text ?? "" };
}

async function ok(method: string, path: string, json: Body) {
  const res = await request(method, `/api/v1${path}`, { json });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return (await res.json()) as Body;
}

// products ATL and BTA; project recon draws from both, project other from ATL only
await ok("POST", "/products", { key: "ATL", name: "Alpha product" });
await ok("POST", "/products", { key: "BTA", name: "Beta product" });
await ok("POST", "/projects", {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
await ok("POST", "/projects", {
  name: "Other",
  slug: "other",
  products: ["ATL"],
});

const reconOnly = await connect(
  createBot(db, "recon-only", {
    scope: { projects: ["recon"], actions: ["read"] },
  }).key,
);
let urls = 0;
const createWebhook = (args: Body) =>
  raw(reconOnly, "create_webhook", {
    url: `https://bot.example.com/mcp/${++urls}`,
    secret: "whsec_mcp_project_0123456789",
    ...args,
  });

test("a project-only key creates an activity webhook on its project over MCP, with projects and by default", async () => {
  const sent = await createWebhook({ projects: ["recon"] });
  expect(sent.isError, sent.text).toBe(false);
  expect(JSON.parse(sent.text)).toMatchObject({
    kind: "activity",
    products: [],
    projects: ["recon"],
  });
  const defaulted = await createWebhook({});
  expect(defaulted.isError, defaulted.text).toBe(false);
  expect(JSON.parse(defaulted.text)).toMatchObject({ projects: ["recon"] });
});

test("create_webhook refuses a project the key doesn't reach and a product it only names", async () => {
  expect(await createWebhook({ projects: ["other"] })).toEqual({
    isError: true,
    text: "not_found: no project other: pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them",
  });
  expect(await createWebhook({ products: ["BTA"] })).toEqual({
    isError: true,
    text: 'not_found: this key reaches product BTA only through project recon: send projects: ["recon"] in place of BTA, for the events of the project\'s items; the rest of BTA needs a key that lists BTA',
  });
});

test("update_webhook and list_webhooks carry projects: a replaced list shows, and one the key doesn't reach is refused", async () => {
  const made = JSON.parse((await createWebhook({ projects: ["recon"] })).text);
  const moved = await raw(reconOnly, "update_webhook", {
    webhookId: made.id,
    url: "https://bot.example.com/mcp/moved",
  });
  expect(moved.isError, moved.text).toBe(false);
  expect(JSON.parse(moved.text)).toMatchObject({
    url: "https://bot.example.com/mcp/moved",
    products: [],
    projects: ["recon"],
  });
  const listed = JSON.parse((await raw(reconOnly, "list_webhooks")).text);
  expect(listed.items.find((w: Body) => w.id === made.id)).toMatchObject({
    products: [],
    projects: ["recon"],
  });

  expect(
    await raw(reconOnly, "update_webhook", {
      webhookId: made.id,
      projects: ["recon", "other"],
    }),
  ).toEqual({
    isError: true,
    text: "not_found: no project other: pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them",
  });
  // the refused edit changed nothing
  const after = JSON.parse((await raw(reconOnly, "list_webhooks")).text);
  expect(after.items.find((w: Body) => w.id === made.id).projects).toEqual([
    "recon",
  ]);
});
