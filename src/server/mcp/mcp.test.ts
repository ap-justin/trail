import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect, test } from "vitest";
import { createBot, revokeKey } from "../service/keys.js";
import { atFakeTime, setupTestApp } from "../test-app.js";

const { app, db, bot } = setupTestApp();

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

const initialize = (headers: Record<string, string>) =>
  app.request(endpoint.href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    }),
  });

const unauthorized = {
  error: {
    code: "unauthorized",
    message: "send Authorization: Bearer <key> with a bot's unrevoked key",
  },
};

test("an MCP call without a key is a 401 in the API's error shape", async () => {
  const res = await initialize({});
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual(unauthorized);
});

test("an MCP call with a revoked key is a 401", async () => {
  const revoked = createBot(db, "revoked mcp bot");
  revokeKey(db, revoked.key.split("_")[1] as string);
  const res = await initialize({ authorization: `Bearer ${revoked.key}` });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual(unauthorized);
});

test("an MCP client with a bot key initializes against trail", async () => {
  const client = await connect(bot.key);
  expect(client.getServerVersion()?.name).toBe("trail");
});

test("GET /mcp is a 405: the endpoint is stateless with no event stream", async () => {
  const res = await app.request(endpoint.href, {
    headers: { authorization: `Bearer ${bot.key}` },
  });
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});

test("tools/list offers one tool per operation, none naming who writes", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      "add_comment",
      "create_issue",
      "create_label",
      "create_project",
      "get_issue",
      "get_project",
      "import_project",
      "list_activity",
      "list_bots",
      "list_comments",
      "list_issues",
      "list_labels",
      "list_projects",
      "list_status_updates",
      "post_status_update",
      "update_issue",
      "update_project",
      "whoami",
    ].sort(),
  );
  for (const tool of tools) {
    const args = Object.keys(tool.inputSchema.properties ?? {});
    // list_activity's actorId filters the feed; it writes nothing
    const writers = args.filter(
      (a) => /actor|author|createdBy/i.test(a) && tool.name !== "list_activity",
    );
    expect(writers, tool.name).toEqual([]);
    expect(tool.description?.length, tool.name).toBeGreaterThan(20);
  }
});

test("tool arguments carry the shared schemas' descriptions", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  const createIssue = tools.find((t) => t.name === "create_issue");
  const props = createIssue?.inputSchema.properties as Record<
    string,
    { description?: string }
  >;
  expect(props.priority?.description).toBe(
    "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
  );
  expect(props.idempotency_key?.description).toMatch(/^Makes the create safe/);
});

// biome-ignore lint/suspicious/noExplicitAny: loose tool results for field reads
type Body = Record<string, any>;

/** The tool's JSON result; fails the test if the tool answered an error. */
async function call(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBeFalsy();
  return JSON.parse(first?.text ?? "null") as Body;
}

/** The text of the tool error `name` answered. */
async function callError(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as { text: string }[])[0]?.text;
}

test("project tools create, get, list and update as the key's bot; a retried create returns the first", async () => {
  const other = createBot(db, "mcp project bot");
  const client = await connect(other.key);
  const args = { key: "MCP", name: "over mcp", idempotency_key: "run-1" };
  const created = await call(client, "create_project", args);
  expect(created).toMatchObject({
    key: "MCP",
    name: "over mcp",
    createdBy: other.actor.id,
  });
  expect(await call(client, "create_project", args)).toEqual(created);

  expect(await call(client, "get_project", { projectId: "mcp" })).toEqual(
    created,
  );
  const listed = await call(client, "list_projects", { limit: 200 });
  expect(
    listed.items.filter((p: Body) => p.key === "MCP").map((p: Body) => p.id),
  ).toEqual([created.id]);
  expect(
    await call(client, "update_project", {
      projectId: "MCP",
      name: "renamed",
    }),
  ).toMatchObject({ id: created.id, name: "renamed" });
});

test("issue tools file, read, list and update an issue with its fields, labels and links", async () => {
  const client = await connect(bot.key);
  await call(client, "create_project", { key: "MCI", name: "issues" });
  const created = await call(client, "create_issue", {
    projectId: "MCI",
    title: "wire it",
    estimate: 1.5,
    priority: 2,
    labels: ["api"],
    links: [{ url: "https://github.com/o/r/pull/9", title: "PR 9" }],
    idempotency_key: "issue-1",
  });
  expect(created).toMatchObject({
    key: "MCI-1",
    estimate: 1.5,
    priority: 2,
    labels: ["api"],
    links: [{ url: "https://github.com/o/r/pull/9", title: "PR 9" }],
    createdBy: bot.actor.id,
    completedAt: null,
  });
  expect(await call(client, "get_issue", { issueId: "MCI-1" })).toEqual(
    created,
  );

  const done = await call(client, "update_issue", {
    issueId: "mci-1",
    status: "done",
    labels: ["api", "shipped"],
  });
  expect(done).toMatchObject({
    status: "done",
    labels: ["api", "shipped"],
    completedAt: expect.any(String),
  });
  const listed = await call(client, "list_issues", {
    projectId: "MCI",
    status: "done",
  });
  expect(listed.items.map((i: Body) => i.key)).toEqual(["MCI-1"]);
  expect(
    (await call(client, "list_issues", { projectId: "MCI", status: "open" }))
      .items,
  ).toEqual([]);
});

test("comment, label and status update tools write and list", async () => {
  const client = await connect(bot.key);
  await call(client, "create_project", { key: "MCC", name: "threads" });
  await call(client, "create_issue", { projectId: "MCC", title: "talk" });
  const comment = await call(client, "add_comment", {
    issueId: "MCC-1",
    body: "first",
    idempotency_key: "c-1",
  });
  expect(comment).toMatchObject({ body: "first", authorId: bot.actor.id });
  expect(
    await call(client, "add_comment", {
      issueId: "MCC-1",
      body: "first",
      idempotency_key: "c-1",
    }),
  ).toEqual(comment);
  expect(
    (await call(client, "list_comments", { issueId: "MCC-1" })).items,
  ).toEqual([comment]);

  const label = await call(client, "create_label", {
    projectId: "MCC",
    name: "Bug",
  });
  expect(
    (await call(client, "list_labels", { projectId: "MCC" })).items,
  ).toEqual([label]);

  const update = await call(client, "post_status_update", {
    projectId: "MCC",
    body: "on schedule",
    health: "on_track",
  });
  expect(update).toMatchObject({ health: "on_track", authorId: bot.actor.id });
  expect(
    (await call(client, "list_status_updates", { projectId: "MCC" })).items,
  ).toEqual([update]);
});

test("list_activity resumes after a cursor and refuses it under other filters", async () => {
  const client = await connect(bot.key);
  const project = await call(client, "create_project", {
    key: "MCA",
    name: "feed",
  });
  await call(client, "create_issue", { projectId: "MCA", title: "one" });
  const start = await call(client, "list_activity", {
    after: "",
    projectId: "MCA",
  });
  expect(start.items.map((e: Body) => e.action)).toEqual([
    "project.created",
    "issue.created",
  ]);

  await call(client, "create_issue", { projectId: "MCA", title: "two" });
  const resumed = await call(client, "list_activity", {
    after: start.nextCursor,
    projectId: project.id,
  });
  expect(resumed.items.map((e: Body) => e.payload.title)).toEqual(["two"]);

  expect(
    await callError(client, "list_activity", { after: start.nextCursor }),
  ).toMatch(
    /^validation_failed: cursor was issued for projectId=.* but this request has projectId=\(none\).*: repeat the cursor's filters, or drop the cursor to start over$/,
  );
});

test("list_activity refuses a cursor sent on the other parameter, naming the one to use", async () => {
  const client = await connect(bot.key);
  await call(client, "create_project", { key: "MCD", name: "direction" });
  await call(client, "create_issue", { projectId: "MCD", title: "one" });
  const oldestFirst = await call(client, "list_activity", {
    after: "",
    projectId: "MCD",
  });
  const newestFirst = await call(client, "list_activity", {
    limit: 1,
    projectId: "MCD",
  });

  expect(
    await callError(client, "list_activity", {
      cursor: oldestFirst.nextCursor,
      projectId: "MCD",
    }),
  ).toMatch(/^validation_failed: .*: send it as after, not as cursor$/);
  expect(
    await callError(client, "list_activity", {
      after: newestFirst.nextCursor,
      projectId: "MCD",
    }),
  ).toMatch(/^validation_failed: .*: send it as cursor, not as after$/);
});

test("a retried create on the other create tools returns the first and writes nothing more", async () => {
  const client = await connect(createBot(db, "mcp retry bot").key);
  await call(client, "create_project", { key: "MCR", name: "retries" });
  const issues = (id: string) => ({
    projectId: "MCR",
    title: id,
    idempotency_key: id,
  });
  const creates: [string, Body, string, Body][] = [
    ["create_issue", issues("r-issue"), "list_issues", { projectId: "MCR" }],
    [
      "create_label",
      { projectId: "MCR", name: "Retry", idempotency_key: "r-label" },
      "list_labels",
      { projectId: "MCR" },
    ],
    [
      "post_status_update",
      {
        projectId: "MCR",
        body: "steady",
        health: "on_track",
        idempotency_key: "r-status",
      },
      "list_status_updates",
      { projectId: "MCR" },
    ],
  ];
  for (const [tool, args, list, listArgs] of creates) {
    const first = await call(client, tool, args);
    expect(await call(client, tool, args), tool).toEqual(first);
    expect((await call(client, list, listArgs)).items, tool).toEqual([first]);
  }
});

test("an idempotency_key reused with a changed body is a tool error and writes nothing", async () => {
  const client = await connect(createBot(db, "mcp reuse bot").key);
  await call(client, "create_project", { key: "MCK", name: "reuse" });
  await call(client, "create_issue", {
    projectId: "MCK",
    title: "first",
    idempotency_key: "reused",
  });
  expect(
    await callError(client, "create_issue", {
      projectId: "MCK",
      title: "changed",
      idempotency_key: "reused",
    }),
  ).toMatch(/^idempotency_key_reused: /);
  expect(
    (await call(client, "list_issues", { projectId: "MCK" })).items.map(
      (i: Body) => i.title,
    ),
  ).toEqual(["first"]);
});

test("a key revoked after the client connected is refused on the next call and writes nothing", async () => {
  const other = createBot(db, "mcp revoked later");
  const client = await connect(other.key);
  await call(client, "create_project", { key: "MCV", name: "before" });
  revokeKey(db, other.key.split("_")[1] as string);
  await expect(
    client.callTool({
      name: "create_issue",
      arguments: { projectId: "MCV", title: "after revoke" },
    }),
  ).rejects.toThrow(/"code":"unauthorized"/);
  const reader = await connect(bot.key);
  expect(
    (await call(reader, "list_issues", { projectId: "MCV" })).items,
  ).toEqual([]);
});

test("import_project imports a project and a re-run changes nothing", async () => {
  const client = await connect(bot.key);
  const payload = {
    externalRef: "lin-proj",
    key: "MCL",
    name: "from linear",
    issues: [
      {
        externalRef: "lin-a",
        title: "a",
        status: "Done",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-02T00:00:00.000Z",
        comments: [
          {
            externalRef: "lin-a-c",
            body: "done",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    ],
  };
  const first = await call(client, "import_project", payload);
  expect(first.created).toMatchObject({ projects: 1, issues: 1, comments: 1 });
  const second = await call(client, "import_project", payload);
  expect(second.created).toEqual({
    projects: 0,
    issues: 0,
    comments: 0,
    labels: 0,
    links: 0,
    statusUpdates: 0,
  });
  expect(second.unchanged).toEqual(first.created);
  expect(await call(client, "get_issue", { issueId: "MCL-1" })).toMatchObject({
    status: "done",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:00.000Z",
  });
});

test("create_issue after import_project numbers past the highest kept Linear number", async () => {
  const client = await connect(bot.key);
  const issue = (externalRef: string) => ({
    externalRef,
    title: externalRef,
    status: "Todo",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const payload = {
    externalRef: "lin-kept",
    key: "MKN",
    name: "kept",
    issues: [issue("MKN-12")],
  };
  await call(client, "import_project", payload);
  await call(client, "import_project", {
    ...payload,
    issues: [issue("MKN-12"), issue("MKN-187")],
  });
  const created = await call(client, "create_issue", {
    projectId: "MKN",
    title: "by hand",
  });
  expect(created.key).toBe("MKN-188");
});

test("whoami answers the key's bot and list_bots pages every bot with id, name and label", async () => {
  const [first, labelled] = atFakeTime([
    () => createBot(db, "mcp listed first"),
    () => createBot(db, "mcp whoami", { label: "agent-mcp" }),
  ]) as [ReturnType<typeof createBot>, ReturnType<typeof createBot>];
  const client = await connect(labelled.key);
  expect(await call(client, "whoami")).toEqual({
    id: labelled.actor.id,
    kind: "bot",
    name: "mcp whoami",
    label: "agent-mcp",
  });

  const items: Body[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(client, "list_bots", { cursor, limit: 2 });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const ids = items.map((i) => i.id);
  expect(ids.indexOf(first.actor.id)).toBe(0);
  expect(ids.indexOf(labelled.actor.id)).toBe(1);
  expect(items[1]).toEqual({
    id: labelled.actor.id,
    name: "mcp whoami",
    label: "agent-mcp",
  });
  expect(ids).toContain(bot.actor.id);
  for (const item of items) {
    expect(Object.keys(item).sort()).toEqual(["id", "label", "name"]);
  }
});

test("a service refusal is a tool error saying what to send instead", async () => {
  const client = await connect(bot.key);
  expect(await callError(client, "get_issue", { issueId: "NOPE-9" })).toBe(
    "not_found: no issue NOPE-9: pass the id or key (like TRL-12) of an existing issue",
  );
  await call(client, "create_project", { key: "MCE", name: "errors" });
  expect(
    await callError(client, "create_project", { key: "MCE", name: "again" }),
  ).toMatch(/^conflict: project key MCE is taken .*: choose another key$/);
  expect(
    await callError(client, "import_project", {
      externalRef: "lin-bad",
      key: "MCB",
      name: "bad",
      issues: [
        {
          externalRef: "x",
          title: "x",
          status: "In Review",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  ).toMatch(/^validation_failed: issue x: status "In Review" has no mapping/);
});

test("a misspelled argument is a tool error naming it", async () => {
  const client = await connect(bot.key);
  expect(await callError(client, "get_project", { projectID: "MCP" })).toMatch(
    /^MCP error -32602: Input validation error: Invalid arguments for tool get_project: .*Unrecognized key: "projectID"/s,
  );
});

test("a link that is not http or https is a tool error naming the url", async () => {
  const client = await connect(bot.key);
  await call(client, "create_project", { key: "MCU", name: "links" });
  for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>"]) {
    expect(
      await callError(client, "create_issue", {
        projectId: "MCU",
        title: "bad link",
        links: [{ url }],
      }),
      url,
    ).toMatch(/must be an http or https url at links\[0\]\.url/);
  }
});

test("project key arguments advertise the key rule as a pattern", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  for (const name of ["create_project", "import_project"]) {
    const props = tools.find((t) => t.name === name)?.inputSchema
      .properties as Record<string, { pattern?: string }>;
    expect(props.key?.pattern, name).toBe("^[A-Za-z0-9]{2,10}$");
  }
});

test("import_project advertises Linear's seven state types for statusType", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  const props = tools.find((t) => t.name === "import_project")?.inputSchema
    .properties as Record<
    string,
    { items?: { properties: Record<string, { enum?: string[] }> } }
  >;
  expect(props.issues?.items?.properties.statusType?.enum).toEqual([
    "backlog",
    "unstarted",
    "triage",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ]);
});

test("list_bots says an id that matches no bot is a human's", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  expect(tools.find((t) => t.name === "list_bots")?.description).toMatch(
    /an id that matches no bot is a human's/,
  );
});
