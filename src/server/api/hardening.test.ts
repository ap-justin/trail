import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { app, db, bot, addBot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
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

async function tool(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  return {
    isError: result.isError === true,
    text: first?.text ?? "",
    body: result.isError ? {} : (JSON.parse(first?.text ?? "null") as Body),
  };
}

let refs = 0;
const issueRow = (sourceKey: string | undefined, extra: Body = {}) => ({
  externalRef: `uuid-${++refs}`,
  ...(sourceKey === undefined ? {} : { sourceKey }),
  title: `issue ${sourceKey ?? refs}`,
  statusType: "started",
  status: "In Review",
  createdAt: "2026-01-02T03:04:05.000Z",
  ...extra,
});

async function importProject(key: string, issues: Body[], extra: Body = {}) {
  const res = await request("POST", "/api/v1/import", {
    json: { externalRef: `proj-${key}`, key, name: key, issues, ...extra },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const get = async (path: string) => {
  const res = await request("GET", `/api/v1${path}`);
  return { status: res.status, body: (await res.json()) as Body };
};

test("an issue is found by its source key over REST and MCP, in any case, and every issue response shows it", async () => {
  const key = projectKey();
  const demo = await importProject(key, [
    issueRow("JUS-5"),
    issueRow("jus-6", {
      comments: [
        {
          externalRef: "c-1",
          body: "noted",
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    }),
    issueRow("JUS-7"),
  ]);
  expect(demo.status).toBe(200);

  const viaRest = await get("/issues/JUS-6");
  expect(viaRest.body).toMatchObject({
    sourceKey: "JUS-6",
    title: "issue jus-6",
  });
  expect((await get("/issues/jus-6")).body.id).toBe(viaRest.body.id);
  expect((await get(`/issues/${viaRest.body.id}`)).body.sourceKey).toBe(
    "JUS-6",
  );
  const list = await get(`/issues?projectId=${key}`);
  expect(list.body.items.map((i: Body) => i.sourceKey).sort()).toEqual([
    "JUS-5",
    "JUS-6",
    "JUS-7",
  ]);
  const comments = await get("/issues/JUS-6/comments");
  expect(comments.body.items).toHaveLength(1);
  const patched = await request("PATCH", "/api/v1/issues/JUS-7", {
    json: { priority: 2 },
  });
  expect(((await patched.json()) as Body).key).toBe(`${key}-3`);
  expect((await get("/issues/JUS-99")).status).toBe(404);

  const client = await connect(bot.key);
  const viaMcp = await tool(client, "get_issue", { issueId: "JUS-6" });
  expect(viaMcp.body).toMatchObject({
    id: viaRest.body.id,
    sourceKey: "JUS-6",
  });
  const commented = await tool(client, "add_comment", {
    issueId: "jus-5",
    body: "by source key",
  });
  expect(commented.body.issueId).toBe((await get("/issues/JUS-5")).body.id);
  const updated = await tool(client, "update_issue", {
    issueId: "JUS-7",
    addLabels: ["seen"],
  });
  expect(updated.body.labels).toEqual(["seen"]);
  expect(
    (await tool(client, "list_comments", { issueId: "JUS-6" })).body.items,
  ).toHaveLength(1);
});

test("a trail key wins over a source key that looks the same", async () => {
  const imported = projectKey();
  const native = projectKey();
  const carried = await importProject(imported, [issueRow(`${native}-1`)]);
  // the prefix is not the project's key, so the issue never asked for number 1 and is not renumbered
  expect(carried.body.renumbered).toEqual([]);
  const importedIssue = (await get(`/issues/${imported}-1`)).body;
  const project = await request("POST", "/api/v1/projects", {
    json: { key: native, name: "native" },
  });
  expect(project.status).toBe(201);
  const nativeIssue = await request("POST", "/api/v1/issues", {
    json: { projectId: native, title: "native one" },
  });
  const nativeBody = (await nativeIssue.json()) as Body;
  expect(nativeBody.key).toBe(`${native}-1`);

  expect((await get(`/issues/${native}-1`)).body.id).toBe(nativeBody.id);
  expect((await get(`/issues/${native.toLowerCase()}-1`)).body.id).toBe(
    nativeBody.id,
  );
  expect((await get(`/issues/${importedIssue.id}`)).body.sourceKey).toBe(
    `${native}-1`,
  );
  const client = await connect(bot.key);
  expect(
    (await tool(client, "get_issue", { issueId: `${native}-1` })).body.id,
  ).toBe(nativeBody.id);
});

test("a re-import gives a taken number the project's next one and lists the renumbered issue", async () => {
  const key = projectKey();
  const carried = issueRow(`${key}-1`);
  const first = await importProject(key, [carried]);
  expect(first.body.renumbered).toEqual([]);
  const byHand = await request("POST", "/api/v1/issues", {
    json: { projectId: key, title: "filed in trail" },
  });
  expect(((await byHand.json()) as Body).key).toBe(`${key}-2`);

  const again = await importProject(key, [
    carried,
    issueRow(`${key}-2`, { externalRef: "uuid-late" }),
  ]);
  expect(again.status).toBe(200);
  expect(again.body.renumbered).toEqual([
    { externalRef: "uuid-late", sourceKey: `${key}-2`, key: `${key}-3` },
  ]);
  expect((await get(`/issues/${key}-3`)).body.externalRef).toBe("uuid-late");
  // the key wins over the source key it asked for
  expect((await get(`/issues/${key}-2`)).body.title).toBe("filed in trail");
});

test("a source key held by another issue is a 409 naming it", async () => {
  const key = projectKey();
  await importProject(key, [issueRow("JUS-300")]);
  const clash = await importProject(projectKey(), [issueRow("JUS-300")]);
  expect(clash.status).toBe(409);
  expect(clash.body.error.message).toMatch(
    /sourceKey JUS-300, but issue \S+ \(externalRef uuid-\d+\) already has it: .*own Linear identifier/,
  );
});

test("bot names are unique ignoring case, and the refusal names the existing bot", () => {
  createBot(db, "Builder");
  expect(() => addBot("builder")).toThrow(
    /a bot named "Builder" already exists \(\S+\), and bot names match ignoring the case of A-Z: pick another name than "builder"/,
  );
  expect(() => addBot("BUILDER")).toThrow(/"Builder" already exists/);
});

test("two bots adding different labels to one issue both keep theirs", async () => {
  const other = addBot("second labeller");
  const issue = (await (
    await request("POST", "/api/v1/issues", {
      json: {
        projectId: (await importProject(projectKey(), [])).body.project.key,
        title: "shared",
      },
    })
  ).json()) as Body;

  const [a, b] = await Promise.all([
    request("PATCH", `/api/v1/issues/${issue.id}`, {
      json: { addLabels: ["alpha"] },
    }),
    request("PATCH", `/api/v1/issues/${issue.id}`, {
      json: { addLabels: ["beta"] },
      key: other.key,
    }),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect((await get(`/issues/${issue.id}`)).body.labels).toEqual([
    "alpha",
    "beta",
  ]);

  const removed = await request("PATCH", `/api/v1/issues/${issue.id}`, {
    json: { removeLabels: ["ALPHA", "never-there"], addLabels: ["Gamma"] },
  });
  expect(((await removed.json()) as Body).labels).toEqual(["Gamma", "beta"]);
});

test("addLinks and removeLinks edit part of the set, matching a removal by url", async () => {
  const project = (await importProject(projectKey(), [])).body.project.key;
  const issue = (await (
    await request("POST", "/api/v1/issues", {
      json: {
        projectId: project,
        title: "links",
        links: [{ url: "https://example.com/a", title: "A" }],
      },
    })
  ).json()) as Body;
  const patch = async (json: Body) => {
    const res = await request("PATCH", `/api/v1/issues/${issue.id}`, { json });
    return { status: res.status, body: (await res.json()) as Body };
  };

  const added = await patch({
    addLinks: [
      { url: "https://example.com/b", title: "B" },
      { url: "https://example.com/a" },
    ],
  });
  expect(added.body.links).toEqual([
    { url: "https://example.com/a", title: "A" },
    { url: "https://example.com/b", title: "B" },
  ]);
  const retitled = await patch({
    addLinks: [{ url: "https://example.com/a", title: "A again" }],
    removeLinks: ["https://example.com/b", "https://example.com/missing"],
  });
  expect(retitled.body.links).toEqual([
    { url: "https://example.com/a", title: "A again" },
  ]);
});

test("labels beside addLabels or removeLabels, and links beside addLinks or removeLinks, are a 422 saying which to send", async () => {
  const project = (await importProject(projectKey(), [])).body.project.key;
  const issue = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: project, title: "mixed", labels: ["keep"] },
    })
  ).json()) as Body;
  for (const json of [
    { labels: ["a"], addLabels: ["b"] },
    { labels: [], removeLabels: ["b"] },
    { links: [], addLinks: [{ url: "https://example.com/x" }] },
    { links: [], removeLinks: ["https://example.com/x"] },
  ]) {
    const res = await request("PATCH", `/api/v1/issues/${issue.id}`, { json });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.message).toMatch(
      /replaces the whole set, so it cannot go with add\w+ or remove\w+: send \w+ alone to replace the set/,
    );
  }
  expect((await get(`/issues/${issue.id}`)).body.labels).toEqual(["keep"]);
});

test("an import takes a 600 KiB description and comment body and 200 links, while a create keeps its limits", async () => {
  const big = "x".repeat(600 * 1024);
  const links = Array.from({ length: 200 }, (_, i) => ({
    url: `https://example.com/${i}`,
  }));
  const key = projectKey();
  const res = await importProject(key, [
    issueRow("JUS-1", {
      description: big,
      links,
      comments: [
        { externalRef: "c-big", body: big, createdAt: "2026-01-03T00:00:00Z" },
      ],
    }),
  ]);
  expect(res.status).toBe(200);
  expect(res.body.created).toMatchObject({
    issues: 1,
    comments: 1,
    links: 200,
  });
  const issue = (await get("/issues/JUS-1")).body;
  expect(issue.description).toHaveLength(600 * 1024);
  expect(issue.links).toHaveLength(200);

  const create = await request("POST", "/api/v1/issues", {
    json: { projectId: key, title: "too long", description: big },
  });
  expect(create.status).toBe(422);
  const manyLinks = await request("POST", "/api/v1/issues", {
    json: { projectId: key, title: "too many", links: links.slice(0, 51) },
  });
  expect(manyLinks.status).toBe(422);
});

test("an import lists every failing row with its sourceKey or externalRef, and writes nothing", async () => {
  const key = projectKey();
  const tooBig = "y".repeat(1024 * 1024 + 1);
  const res = await importProject(key, [
    issueRow("JUS-10"),
    issueRow("JUS-11", { description: tooBig }),
    issueRow(undefined, { externalRef: "no-key", priority: 9 }),
    issueRow("JUS-13", {
      links: Array.from({ length: 201 }, (_, i) => ({
        url: `https://example.com/${i}`,
      })),
    }),
    issueRow("JUS-14", {
      comments: [
        { externalRef: "c-1", body: "  ", createdAt: "2026-01-03T00:00:00Z" },
      ],
    }),
  ]);
  expect(res.status).toBe(422);
  const message: string = res.body.error.message;
  expect(message).toMatch(/^4 import problems/);
  expect(message).toMatch(
    /- issue JUS-11 \(externalRef uuid-\d+\) description is 1048577 characters, over the limit of 1048576/,
  );
  expect(message).toMatch(/- issue no-key: priority must be 0/);
  expect(message).toMatch(
    /- issue JUS-13 \(externalRef uuid-\d+\) lists 201 links, over the limit of 200/,
  );
  expect(message).toMatch(
    /- comment c-1 of issue JUS-14 .*body must not be empty/,
  );
  expect(message).not.toMatch(/JUS-10/);
  expect((await get(`/issues?projectId=${key}`)).status).toBe(404);

  const client = await connect(bot.key);
  const viaMcp = await tool(client, "import_project", {
    externalRef: "mcp-bad",
    key: projectKey(),
    name: "bad",
    issues: [
      issueRow("JUS-20", { description: tooBig }),
      issueRow("JUS-21", { title: " " }),
    ],
  });
  expect(viaMcp.isError).toBe(true);
  expect(viaMcp.text).toMatch(/^validation_failed: 2 import problems/);
  expect(viaMcp.text).toMatch(/JUS-20/);
  expect(viaMcp.text).toMatch(/JUS-21/);
});

test("a re-import whose label differs only by case renames the label, and the counts show just that", async () => {
  const key = projectKey();
  const issues = (label: string) => [
    issueRow("JUS-30", { externalRef: "stable", labels: [label] }),
  ];
  const first = await importProject(key, issues("Bug"));
  expect(first.body.created.labels).toBe(1);
  const again = await importProject(key, issues("bug"));
  expect(again.status).toBe(200);
  const zero = {
    projects: 0,
    issues: 0,
    comments: 0,
    labels: 0,
    links: 0,
    statusUpdates: 0,
  };
  expect(again.body.created).toEqual(zero);
  expect(again.body.updated).toEqual({ ...zero, labels: 1 });
  expect(again.body.unchanged).toMatchObject({ projects: 1, issues: 1 });
  expect((await get(`/projects/${key}/labels`)).body.items).toMatchObject([
    { name: "bug" },
  ]);
  expect((await get("/issues/JUS-30")).body.labels).toEqual(["bug"]);
  const third = await importProject(key, issues("bug"));
  expect(third.body.updated).toEqual(zero);
});
