import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { app, db, bot, request, addProject } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose tool results for field reads
type Body = Record<string, any>;

const endpoint = new URL("http://trail.test/mcp");
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

/** An MCP client over the in-process app, sending `key` as its bearer key. */
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

const a = addProject("A");
const scoped = createBot(db, "bg-ivy", {
  scope: { projects: [a.key], actions: ["read", "issues", "comments"] },
});
let ivy: Client;
let wide: Client;
let issueA = "";

beforeAll(async () => {
  ivy = await connect(scoped.key);
  wide = await connect(bot.key);
  issueA = (await call(wide, "file_issue", { product: a.key, title: "a" })).key;
});

/** The tool's JSON result; fails the test if the tool answered an error. */
async function call(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBeFalsy();
  return JSON.parse(first?.text ?? "null") as Body;
}

/** The whole tool result, error or not. */
const raw = (client: Client, name: string, args: Body = {}) =>
  client.callTool({ name, arguments: args });

/** A product with an item, a comment, a label and a status update, by the unscoped bot. */
async function hiddenProject(key = projectKey()) {
  const project = await call(wide, "create_product", { key, name: "B" });
  const issue = await call(wide, "add_todo", { product: key, title: "b" });
  await call(wide, "add_comment", { item: issue.key, body: "b" });
  await call(wide, "create_label", { product: key, name: "bug" });
  await call(wide, "post_status_update", {
    product: key,
    body: "ok",
    health: "on_track",
  });
  return { project, issue };
}

// Every tool that takes a product or item reference, with its arguments for product K.
const keyed: [string, (k: string) => Body][] = [
  ["get_product", (k) => ({ product: k })],
  ["update_product", (k) => ({ product: k, name: "renamed" })],
  ["get_project", (k) => ({ project: k })],
  ["update_project", (k) => ({ project: k, name: "renamed" })],
  ["list_labels", (k) => ({ product: k })],
  ["create_label", (k) => ({ product: k, name: "new" })],
  ["list_status_updates", (k) => ({ product: k })],
  ["post_status_update", (k) => ({ product: k, body: "x", health: "at_risk" })],
  ["list_items", (k) => ({ product: k })],
  ["add_todo", (k) => ({ product: k, title: "t" })],
  ["file_issue", (k) => ({ product: k, title: "t" })],
  ["create_project", (k) => ({ name: "p", products: [k] })],
  ["get_item", (k) => ({ item: `${k}-1` })],
  ["update_item", (k) => ({ item: `${k}-1`, title: "t2" })],
  ["list_comments", (k) => ({ item: `${k}-1` })],
  ["add_comment", (k) => ({ item: `${k}-1`, body: "c" })],
  ["list_activity", (k) => ({ product: k })],
  ["create_issue", (k) => ({ projectId: k, title: "t" })],
  ["list_issues", (k) => ({ projectId: k })],
];

test("a product outside the key's products answers exactly as one that doesn't exist, on every keyed tool", async () => {
  const k = projectKey();
  const snapshot = () =>
    Promise.all(
      keyed.map(async ([tool, args]) => ({
        tool,
        result: await raw(ivy, tool, args(k)),
      })),
    );
  const missing = await snapshot();
  await hiddenProject(k);
  const hidden = await snapshot();

  expect(hidden).toEqual(missing);
  for (const { tool, result } of missing) {
    expect(result.isError, tool).toBe(true);
    const [first] = result.content as { text: string }[];
    expect(first?.text, tool).toMatch(/^not_found: no (product|project|item) /);
  }
});

test("tools/list offers a scoped key every tool", async () => {
  const [mine, all] = await Promise.all([ivy.listTools(), wide.listTools()]);
  expect(mine.tools.map((t) => t.name)).toEqual(all.tools.map((t) => t.name));
});

test("a refused tool call carries the same text as the REST refusal", async () => {
  for (const [tool, args, method, path, json] of [
    [
      "post_status_update",
      { product: a.key, body: "ok", health: "on_track" },
      "POST",
      `/api/v1/products/${a.key}/status-updates`,
      { body: "ok", health: "on_track" },
    ],
    ["list_bots", {}, "GET", "/api/v1/bots", undefined],
  ] as const) {
    const res = await request(method, path, { key: scoped.key, json });
    const { error } = (await res.json()) as Body;
    expect(res.status).toBe(403);
    expect(await raw(ivy, tool, args)).toEqual({
      content: [{ type: "text", text: `${error.code}: ${error.message}` }],
      isError: true,
    });
  }
});

test("list tools show a scoped key only its products, their items and their activity", async () => {
  const b = await hiddenProject();
  expect(
    (await call(ivy, "list_products")).items.map((p: Body) => p.key),
  ).toEqual([a.key]);
  const everyIssue = await call(wide, "list_items", { limit: 200 });
  expect(everyIssue.nextCursor).toBeNull();
  const inA = everyIssue.items
    .filter((i: Body) => i.projectId === a.id)
    .map((i: Body) => i.key);
  // the unscoped list is live: it holds the hidden issue and A's own
  expect(everyIssue.items.map((i: Body) => i.key)).toContain(b.issue.key);
  expect(inA).toContain(issueA);
  expect(
    (await call(ivy, "list_items", { limit: 200 })).items.map(
      (i: Body) => i.key,
    ),
  ).toEqual(inA);
  const all = (await call(wide, "list_activity", { limit: 200 })).items;
  expect(all.some((e: Body) => e.projectId === b.project.id)).toBe(true);

  const followed: Body[] = [];
  let after = "";
  for (;;) {
    const page = await call(ivy, "list_activity", { after, limit: 1 });
    if (page.items.length === 0) break;
    followed.push(...page.items);
    after = page.nextCursor;
  }
  expect(followed.map((e) => e.id)).toEqual(
    all
      .filter((e: Body) => e.projectId === a.id)
      .map((e: Body) => e.id)
      .reverse(),
  );
});

test("a key scoped to A files issues and comments in A", async () => {
  const filed = await call(ivy, "file_issue", {
    product: a.key,
    title: "by ivy",
  });
  expect(filed).toMatchObject({ title: "by ivy", product: a.key });
  const updated = await call(ivy, "update_item", {
    item: filed.key,
    status: "in_progress",
  });
  expect(updated.status).toBe("in_progress");
  await call(ivy, "add_comment", { item: filed.key, body: "on it" });
  const comments = await call(wide, "list_comments", { item: filed.key });
  expect(comments.items.map((c: Body) => c.body)).toEqual(["on it"]);
});

/** Each tool a key's actions gate, with the action it needs and its arguments in product A. */
const gated = (): [string, string, () => Body][] => [
  ["get_product", "read", () => ({ product: a.key })],
  ["list_products", "read", () => ({})],
  ["list_projects", "read", () => ({})],
  ["get_item", "read", () => ({ item: issueA })],
  ["list_items", "read", () => ({})],
  ["list_comments", "read", () => ({ item: issueA })],
  ["list_labels", "read", () => ({ product: a.key })],
  ["list_status_updates", "read", () => ({ product: a.key })],
  ["list_activity", "read", () => ({})],
  ["add_todo", "issues", () => ({ product: a.key, title: "t" })],
  ["file_issue", "issues", () => ({ product: a.key, title: "t" })],
  ["update_item", "issues", () => ({ item: issueA, title: "t" })],
  [
    "create_project",
    "issues",
    () => ({ name: `p ${projectKey()}`, products: [a.key] }),
  ],
  ["add_comment", "comments", () => ({ item: issueA, body: "c" })],
  [
    "post_status_update",
    "status_updates",
    () => ({ product: a.key, body: "ok", health: "on_track" }),
  ],
  ["create_product", "admin", () => ({ key: projectKey(), name: "n" })],
  ["update_product", "admin", () => ({ product: a.key, description: "d" })],
  [
    "create_label",
    "admin",
    () => ({ product: a.key, name: `l ${projectKey()}` }),
  ],
  [
    "import_project",
    "admin",
    () => ({
      externalRef: `ext-${projectKey()}`,
      key: projectKey(),
      name: "i",
      issues: [],
      statusUpdates: [],
    }),
  ],
  ["list_bots", "admin", () => ({})],
];

test.each(["read", "issues", "comments", "status_updates", "admin"])(
  "a key with only %s may call exactly the tools that need it, and whoami",
  async (action) => {
    const only = await connect(
      createBot(db, `mcp only ${action}`, { scope: { actions: [action] } }).key,
    );
    for (const [tool, needs, args] of gated()) {
      const result = await raw(only, tool, args());
      const [first] = result.content as { text: string }[];
      if (needs === action) {
        expect(result.isError, `${tool}: ${first?.text}`).toBeFalsy();
      } else {
        expect(first?.text, tool).toMatch(
          new RegExp(`^forbidden_action: .* needs the ${needs} action`),
        );
      }
    }
    expect((await call(only, "whoami")).scope).toEqual({
      products: null,
      projects: null,
      actions: [action],
    });
  },
);

test("whoami reports a scoped key's products and actions", async () => {
  expect((await call(ivy, "whoami")).scope).toEqual({
    products: [a.key],
    projects: [a.key],
    actions: ["read", "issues", "comments"],
  });
});

test("import_project refuses a source key a hidden issue holds naming nothing of it, and still names a visible holder", async () => {
  const withIssue = (
    externalRef: string,
    key: string,
    issueRef: string,
    sourceKey: string,
  ) => ({
    externalRef,
    key,
    name: "imported",
    issues: [
      {
        externalRef: issueRef,
        sourceKey,
        title: "t",
        status: "Todo",
        createdAt: "2026-01-02T03:04:05.000Z",
      },
    ],
  });
  const inside = projectKey();
  await call(
    wide,
    "import_project",
    withIssue(`ext-${projectKey()}`, projectKey(), "hid-601", "LIN-601"),
  );
  await call(
    wide,
    "import_project",
    withIssue(`ext-${inside}`, inside, "vis-602", "LIN-602"),
  );
  const hiddenId = (await call(wide, "get_item", { item: "LIN-601" })).id;
  const visibleId = (await call(wide, "get_item", { item: "LIN-602" })).id;

  const importer = await connect(
    createBot(db, "mcp scoped source-key importer", {
      scope: { projects: [inside], actions: ["admin"] },
    }).key,
  );
  const attempt = (client: Client, sourceKey: string) =>
    raw(
      client,
      "import_project",
      withIssue(`ext-${inside}`, inside, "new-603", sourceKey),
    );
  const refused = (holder: string, sourceKey: string) => ({
    content: [
      {
        type: "text",
        text: `conflict: issue new-603 sends sourceKey ${sourceKey}, but ${holder} already has it: a source key names one issue, so send each issue its own Linear identifier`,
      },
    ],
    isError: true,
  });

  const hidden = await attempt(importer, "LIN-601");
  const [first] = hidden.content as { text: string }[];
  expect(first?.text).not.toContain(hiddenId);
  expect(first?.text).not.toContain("hid-601");
  expect(hidden).toEqual(refused("another issue", "LIN-601"));
  expect(await attempt(importer, "LIN-602")).toEqual(
    refused(`issue ${visibleId} (externalRef vis-602)`, "LIN-602"),
  );
  expect(await attempt(wide, "LIN-601")).toEqual(
    refused(`issue ${hiddenId} (externalRef hid-601)`, "LIN-601"),
  );
});
