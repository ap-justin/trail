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
  issueA = (await call(wide, "create_issue", { projectId: a.key, title: "a" }))
    .key;
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

/** A project with an issue, a comment, a label and a status update, by the unscoped bot. */
async function hiddenProject(key = projectKey()) {
  const project = await call(wide, "create_project", { key, name: "B" });
  const issue = await call(wide, "create_issue", {
    projectId: key,
    title: "b",
  });
  await call(wide, "add_comment", { issueId: issue.key, body: "b" });
  await call(wide, "create_label", { projectId: key, name: "bug" });
  await call(wide, "post_status_update", {
    projectId: key,
    body: "ok",
    health: "on_track",
  });
  return { project, issue };
}

// Every tool that takes a project or issue reference, with its arguments for project K.
const keyed: [string, (k: string) => Body][] = [
  ["get_project", (k) => ({ projectId: k })],
  ["update_project", (k) => ({ projectId: k, name: "renamed" })],
  ["list_labels", (k) => ({ projectId: k })],
  ["create_label", (k) => ({ projectId: k, name: "new" })],
  ["list_status_updates", (k) => ({ projectId: k })],
  [
    "post_status_update",
    (k) => ({ projectId: k, body: "x", health: "at_risk" }),
  ],
  ["list_issues", (k) => ({ projectId: k })],
  ["create_issue", (k) => ({ projectId: k, title: "t" })],
  ["get_issue", (k) => ({ issueId: `${k}-1` })],
  ["update_issue", (k) => ({ issueId: `${k}-1`, title: "t2" })],
  ["list_comments", (k) => ({ issueId: `${k}-1` })],
  ["add_comment", (k) => ({ issueId: `${k}-1`, body: "c" })],
  ["list_activity", (k) => ({ projectId: k })],
];

test("a project outside the key's projects answers exactly as one that doesn't exist, on every keyed tool", async () => {
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
    expect(first?.text, tool).toMatch(/^not_found: no (project|issue) /);
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
      { projectId: a.key, body: "ok", health: "on_track" },
      "POST",
      `/api/v1/projects/${a.key}/status-updates`,
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

test("list tools show a scoped key only its projects, their issues and their activity", async () => {
  const b = await hiddenProject();
  expect(
    (await call(ivy, "list_projects")).items.map((p: Body) => p.key),
  ).toEqual([a.key]);
  expect(
    (await call(ivy, "list_issues")).items.map((i: Body) => i.key),
  ).toEqual([issueA]);
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

/** Each tool a key's actions gate, with the action it needs and its arguments in project A. */
const gated = (): [string, string, () => Body][] => [
  ["get_project", "read", () => ({ projectId: a.key })],
  ["list_projects", "read", () => ({})],
  ["get_issue", "read", () => ({ issueId: issueA })],
  ["list_issues", "read", () => ({})],
  ["list_comments", "read", () => ({ issueId: issueA })],
  ["list_labels", "read", () => ({ projectId: a.key })],
  ["list_status_updates", "read", () => ({ projectId: a.key })],
  ["list_activity", "read", () => ({})],
  ["create_issue", "issues", () => ({ projectId: a.key, title: "t" })],
  ["update_issue", "issues", () => ({ issueId: issueA, title: "t" })],
  ["add_comment", "comments", () => ({ issueId: issueA, body: "c" })],
  [
    "post_status_update",
    "status_updates",
    () => ({ projectId: a.key, body: "ok", health: "on_track" }),
  ],
  ["create_project", "admin", () => ({ key: projectKey(), name: "n" })],
  ["update_project", "admin", () => ({ projectId: a.key, description: "d" })],
  [
    "create_label",
    "admin",
    () => ({ projectId: a.key, name: `l ${projectKey()}` }),
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
      projects: null,
      actions: [action],
    });
  },
);

test("whoami reports a scoped key's projects and actions", async () => {
  expect((await call(ivy, "whoami")).scope).toEqual({
    projects: [a.key],
    actions: ["read", "issues", "comments"],
  });
});
