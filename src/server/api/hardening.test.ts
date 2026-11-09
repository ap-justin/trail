import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, test } from "vitest";
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
let sourceKeys = 0;
/** A source key no other test in this file has used; they share one database and source keys are unique across it. */
const freshSourceKey = (prefix = "JUS") => `${prefix}-${++sourceKeys}`;
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
  const five = freshSourceKey();
  const six = freshSourceKey();
  const seven = freshSourceKey();
  const demo = await importProject(key, [
    issueRow(five),
    issueRow(six.toLowerCase(), {
      comments: [
        {
          externalRef: "c-1",
          body: "noted",
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    }),
    issueRow(seven),
  ]);
  expect(demo.status).toBe(200);

  const viaRest = await get(`/issues/${six}`);
  expect(viaRest.body).toMatchObject({
    sourceKey: six,
    title: `issue ${six.toLowerCase()}`,
  });
  expect((await get(`/issues/${six.toLowerCase()}`)).body.id).toBe(
    viaRest.body.id,
  );
  expect((await get(`/issues/${viaRest.body.id}`)).body.sourceKey).toBe(six);
  const list = await get(`/issues?projectId=${key}`);
  expect(list.body.items.map((i: Body) => i.sourceKey).sort()).toEqual(
    [five, six, seven].sort(),
  );
  const comments = await get(`/issues/${six}/comments`);
  expect(comments.body.items).toHaveLength(1);
  const patched = await request("PATCH", `/api/v1/issues/${seven}`, {
    json: { priority: 2 },
  });
  const patchedBody = (await patched.json()) as Body;
  expect(patchedBody.sourceKey).toBe(seven);
  expect(patchedBody.priority).toBe(2);
  expect((await get(`/issues/${freshSourceKey()}`)).status).toBe(404);

  const client = await connect(bot.key);
  const viaMcp = await tool(client, "get_issue", { issueId: six });
  expect(viaMcp.body).toMatchObject({
    id: viaRest.body.id,
    sourceKey: six,
  });
  const commented = await tool(client, "add_comment", {
    issueId: five.toLowerCase(),
    body: "by source key",
  });
  expect(commented.body.issueId).toBe((await get(`/issues/${five}`)).body.id);
  const updated = await tool(client, "update_issue", {
    issueId: seven,
    addLabels: ["seen"],
  });
  expect(updated.body.labels).toEqual(["seen"]);
  expect(
    (await tool(client, "list_comments", { issueId: six })).body.items,
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
  const held = freshSourceKey();
  await importProject(key, [issueRow(held)]);
  const clashKey = projectKey();
  const clash = await importProject(clashKey, [
    issueRow(freshSourceKey()),
    issueRow(held),
  ]);
  expect(clash.status).toBe(409);
  expect(clash.body.error.message).toMatch(
    new RegExp(
      `sourceKey ${held}, but issue \\S+ \\(externalRef uuid-\\d+\\) already has it: .*own Linear identifier`,
    ),
  );
  // the failed import rolled back: the other project and its first row never landed, the holder is intact
  expect((await get(`/issues?projectId=${clashKey}`)).status).toBe(404);
  expect((await get(`/issues?projectId=${key}`)).body.items).toHaveLength(1);
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
  const bigKey = freshSourceKey();
  const res = await importProject(key, [
    issueRow(bigKey, {
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
  const issue = (await get(`/issues/${bigKey}`)).body;
  expect(issue.description).toHaveLength(600 * 1024);
  expect(issue.links).toHaveLength(200);

  const create = await request("POST", "/api/v1/issues", {
    json: { projectId: key, title: "too long", description: big },
  });
  expect(create.status).toBe(422);
  expect(((await create.json()) as Body).error.message).toMatch(
    /^description: .*<=65536 characters/,
  );
  const manyLinks = await request("POST", "/api/v1/issues", {
    json: { projectId: key, title: "too many", links: links.slice(0, 51) },
  });
  expect(manyLinks.status).toBe(422);
  expect(((await manyLinks.json()) as Body).error.message).toMatch(/links.*50/);
});

test("an import lists every failing row with its sourceKey or externalRef, and writes nothing", async () => {
  const key = projectKey();
  const tooBig = "y".repeat(1024 * 1024 + 1);
  const ok = freshSourceKey();
  const big = freshSourceKey();
  const links = freshSourceKey();
  const comment = freshSourceKey();
  const mcpBig = freshSourceKey();
  const mcpTitle = freshSourceKey();
  const res = await importProject(key, [
    issueRow(ok),
    issueRow(big, { description: tooBig }),
    issueRow(undefined, { externalRef: "no-key", priority: 9 }),
    issueRow(links, {
      links: Array.from({ length: 201 }, (_, i) => ({
        url: `https://example.com/${i}`,
      })),
    }),
    issueRow(comment, {
      comments: [
        { externalRef: "c-1", body: "  ", createdAt: "2026-01-03T00:00:00Z" },
      ],
    }),
  ]);
  expect(res.status).toBe(422);
  const message: string = res.body.error.message;
  expect(message).toMatch(/^4 import problems/);
  expect(message).toMatch(
    new RegExp(
      `- issue ${big} \\(externalRef uuid-\\d+\\) description is 1048577 characters, over the limit of 1048576`,
    ),
  );
  expect(message).toMatch(/- issue no-key: priority must be 0/);
  expect(message).toMatch(
    new RegExp(
      `- issue ${links} \\(externalRef uuid-\\d+\\) lists 201 links, over the limit of 200`,
    ),
  );
  expect(message).toMatch(
    new RegExp(`- comment c-1 of issue ${comment} .*body must not be empty`),
  );
  expect(message).not.toMatch(new RegExp(ok));
  expect((await get(`/issues?projectId=${key}`)).status).toBe(404);

  const client = await connect(bot.key);
  const viaMcp = await tool(client, "import_project", {
    externalRef: "mcp-bad",
    key: projectKey(),
    name: "bad",
    issues: [
      issueRow(mcpBig, { description: tooBig }),
      issueRow(mcpTitle, { title: " " }),
    ],
  });
  expect(viaMcp.isError).toBe(true);
  expect(viaMcp.text).toMatch(/^validation_failed: 2 import problems/);
  expect(viaMcp.text).toMatch(new RegExp(mcpBig));
  expect(viaMcp.text).toMatch(new RegExp(mcpTitle));
});

test("a re-import whose label differs only by case renames the label, and the counts show just that", async () => {
  const key = projectKey();
  const labelled = freshSourceKey();
  const issues = (label: string) => [
    issueRow(labelled, { externalRef: "stable", labels: [label] }),
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
  expect((await get(`/issues/${labelled}`)).body.labels).toEqual(["bug"]);
  const third = await importProject(key, issues("bug"));
  expect(third.body.updated).toEqual(zero);
});

describe("addLabels and addLinks keep the 50-item caps of a full replace", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => i);

  async function issueWith(json: Body) {
    const project = (await importProject(projectKey(), [])).body.project.key;
    const res = await request("POST", "/api/v1/issues", {
      json: { projectId: project, title: "capped", ...json },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as Body).id as string;
  }
  const patch = async (id: string, json: Body) => {
    const res = await request("PATCH", `/api/v1/issues/${id}`, { json });
    return { status: res.status, body: (await res.json()) as Body };
  };

  test("an addLabels that takes the set past 50 is a 422 and writes nothing", async () => {
    const id = await issueWith({ labels: fifty.map((i) => `l${i}`) });
    const over = await patch(id, { addLabels: ["one-more"] });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: "validation_failed" });
    expect(over.body.error.message).toMatch(/51 labels.*50/);
    expect((await get(`/issues/${id}`)).body.labels).toHaveLength(50);

    // a swap that stays at 50, and re-adding a held name, are fine
    const swap = await patch(id, {
      removeLabels: ["l0"],
      addLabels: ["L1", "new"],
    });
    expect(swap.status).toBe(200);
    expect(swap.body.labels).toHaveLength(50);
  });

  test("an addLinks that takes the set past 50 is a 422 and writes nothing", async () => {
    const url = (i: number | string) => `https://example.com/${i}`;
    const id = await issueWith({ links: fifty.map((i) => ({ url: url(i) })) });
    const over = await patch(id, { addLinks: [{ url: url("more") }] });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: "validation_failed" });
    expect(over.body.error.message).toMatch(/51 links.*50/);
    expect((await get(`/issues/${id}`)).body.links).toHaveLength(50);

    const retitle = await patch(id, {
      removeLinks: [url(0)],
      addLinks: [{ url: url(1), title: "one" }, { url: url("more") }],
    });
    expect(retitle.status).toBe(200);
    expect(retitle.body.links).toHaveLength(50);
  });
});
