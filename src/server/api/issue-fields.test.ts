import { beforeAll, expect, test } from "vitest";
import { projectKey, setupTestApp } from "../test-app.js";

const { request, published } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

async function send(
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: Body }> {
  const res = await request(method, `/api/v1${path}`, { json });
  return { status: res.status, body: (await res.json()) as Body };
}

async function created(path: string, json: unknown): Promise<Body> {
  const { status, body } = await send("POST", path, json);
  expect(status, JSON.stringify(body)).toBe(201);
  return body;
}

let trl: Body;
beforeAll(async () => {
  trl = await created("/projects", { key: "TRL", name: "trail" });
});

test("issues are numbered from 1 within each project and keyed by it", async () => {
  const other = await created("/projects", { key: "OTH", name: "other" });
  const a = await created("/issues", { projectId: trl.id, title: "a" });
  const b = await created("/issues", { projectId: trl.id, title: "b" });
  const c = await created("/issues", { projectId: other.id, title: "c" });
  expect([a.key, a.number, b.key, b.number, c.key, c.number]).toEqual([
    "TRL-1",
    1,
    "TRL-2",
    2,
    "OTH-1",
    1,
  ]);
});

test("every issue route takes the issue's key, in any case, as well as its id", async () => {
  const issue = await created("/issues", { projectId: trl.id, title: "k" });
  const lower = issue.key.toLowerCase();

  const got = await send("GET", `/issues/${issue.key}`);
  expect(got.body.id).toBe(issue.id);
  expect((await send("GET", `/issues/${lower}`)).body.id).toBe(issue.id);

  const patched = await send("PATCH", `/issues/${issue.key}`, {
    status: "done",
  });
  expect(patched.body).toMatchObject({ id: issue.id, status: "done" });

  const comment = await created(`/issues/${lower}/comments`, { body: "hi" });
  expect(comment.issueId).toBe(issue.id);
  const thread = await send("GET", `/issues/${issue.key}/comments`);
  expect(thread.body.items.map((c: Body) => c.id)).toEqual([comment.id]);
});

test("an unknown issue key is a 404 that says what to pass", async () => {
  for (const ref of ["TRL-999", "NOPE-1"]) {
    const { status, body } = await send("GET", `/issues/${ref}`);
    expect(status).toBe(404);
    expect(body.error.message).toBe(
      `no issue ${ref}: pass the id, the key (like TRL-12) or the source key (like JUS-187, kept from an import) of an existing issue`,
    );
  }
});

test("projectId takes the project's key, in any case, in a body, a path and a query", async () => {
  const filed = await created("/issues", { projectId: "trl", title: "by key" });
  expect(filed.projectId).toBe(trl.id);
  expect((await send("GET", "/projects/trl")).body.id).toBe(trl.id);
  const listed = await send("GET", "/issues?projectId=TRL&limit=200");
  expect(listed.body.items.map((i: Body) => i.id)).toContain(filed.id);
  const feed = await send("GET", "/activity?projectId=TRL&limit=1");
  expect(feed.body.items[0].projectId).toBe(trl.id);
});

test("a filter naming no project is a 404, not an empty page", async () => {
  for (const path of ["/issues?projectId=NOPE", "/activity?projectId=NOPE"]) {
    const { status, body } = await send("GET", path);
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  }
});

test("a project key is stored uppercased; a malformed one is a 422", async () => {
  const lower = await created("/projects", { key: "low1", name: "lower" });
  expect(lower.key).toBe("LOW1");
  for (const key of ["A", "TOOLONGKEY1", "TR-L", ""]) {
    const { status, body } = await send("POST", "/projects", {
      key,
      name: "bad key",
    });
    expect(status, key).toBe(422);
    expect(body.error.message).toBe(
      "key: must be 2 to 10 letters A-Z or digits, like TRL",
    );
  }
});

test("a project key in use is a 409 naming the holder", async () => {
  const { status, body } = await send("POST", "/projects", {
    key: "trl",
    name: "again",
  });
  expect(status).toBe(409);
  expect(body.error).toEqual({
    code: "conflict",
    message: `project key TRL is taken by project ${trl.id} ("trail"): choose another key`,
  });
});

test("POST /issues sets estimate, priority, labels, links and externalRef", async () => {
  const issue = await created("/issues", {
    projectId: trl.id,
    title: "fields",
    estimate: 2.5,
    priority: 2,
    labels: ["bug", "Backend", "BUG"],
    links: [
      { url: "https://github.com/ap-justin/trail/pull/3", title: "PR #3" },
      { url: "https://example.com/spec" },
    ],
    externalRef: "JUS-188",
  });
  expect(issue).toMatchObject({
    estimate: 2.5,
    priority: 2,
    labels: ["Backend", "bug"],
    links: [
      { url: "https://github.com/ap-justin/trail/pull/3", title: "PR #3" },
      { url: "https://example.com/spec", title: "https://example.com/spec" },
    ],
    externalRef: "JUS-188",
  });
  expect((await send("GET", `/issues/${issue.key}`)).body).toEqual(issue);
  expect(published.at(-1)).toMatchObject({
    action: "issue.created",
    payload: {
      key: issue.key,
      estimate: 2.5,
      priority: 2,
      labels: ["Backend", "bug"],
      externalRef: "JUS-188",
    },
  });
});

test("a label named on an issue is created once and then matched in any case", async () => {
  const project = await created("/projects", {
    key: projectKey(),
    name: "labels on use",
  });
  await created("/issues", {
    projectId: project.id,
    title: "1",
    labels: ["Infra"],
  });
  const second = await created("/issues", {
    projectId: project.id,
    title: "2",
    labels: ["infra", "docs"],
  });
  expect(second.labels).toEqual(["Infra", "docs"]);
  const labels = await send("GET", `/projects/${project.key}/labels`);
  expect(labels.body.items.map((l: Body) => l.name)).toEqual(["Infra", "docs"]);
});

test("PATCH /issues replaces labels and links and records each change from and to", async () => {
  const issue = await created("/issues", {
    projectId: trl.id,
    title: "relabel",
    labels: ["a"],
    links: [{ url: "https://example.com/1", title: "one" }],
  });
  const before = published.length;
  const { status, body } = await send("PATCH", `/issues/${issue.id}`, {
    labels: ["b", "a"],
    links: [{ url: "https://example.com/2", title: "two" }],
    estimate: 1,
    priority: 4,
  });
  expect(status).toBe(200);
  expect(body).toMatchObject({
    labels: ["a", "b"],
    links: [{ url: "https://example.com/2", title: "two" }],
    estimate: 1,
    priority: 4,
  });
  expect(published.slice(before)).toEqual([
    expect.objectContaining({
      action: "issue.updated",
      payload: {
        labels: { from: ["a"], to: ["a", "b"] },
        links: {
          from: [{ url: "https://example.com/1", title: "one" }],
          to: [{ url: "https://example.com/2", title: "two" }],
        },
        estimate: { from: null, to: 1 },
        priority: { from: 0, to: 4 },
      },
    }),
  ]);

  const cleared = await send("PATCH", `/issues/${issue.id}`, {
    labels: [],
    links: [],
    estimate: null,
  });
  expect(cleared.body).toMatchObject({ labels: [], links: [], estimate: null });
});

test("a PATCH setting the labels and links an issue already has writes nothing", async () => {
  const issue = await created("/issues", {
    projectId: trl.id,
    title: "same",
    labels: ["x"],
    links: [{ url: "https://example.com/x", title: "x" }],
  });
  const before = published.length;
  const { status } = await send("PATCH", `/issues/${issue.id}`, {
    labels: ["X"],
    links: [{ url: "https://example.com/x", title: "x" }],
  });
  expect(status).toBe(200);
  expect(published.length).toBe(before);
});

test("a link may be https or http, a localhost one included", async () => {
  const links = [
    { url: "https://example.com/spec", title: "spec" },
    { url: "http://localhost:3000/issues/1", title: "local" },
  ];
  const issue = await created("/issues", {
    projectId: trl.id,
    title: "linked",
    links,
  });
  expect(issue.links).toEqual(links);
});

test.each([
  ["priority 5", { priority: 5 }, /^priority: /],
  ["priority 1.5", { priority: 1.5 }, /^priority: /],
  ["a negative estimate", { estimate: -1 }, /^estimate: /],
  ["a link that is not a url", { links: [{ url: "nope" }] }, /^links\.0\.url/],
  [
    "a javascript: link",
    { links: [{ url: "javascript:alert(document.cookie)" }] },
    /^links\.0\.url: must be an http or https url$/,
  ],
  [
    "a data: link",
    { links: [{ url: "data:text/html,<script>alert(1)</script>" }] },
    /^links\.0\.url: must be an http or https url$/,
  ],
  [
    "a url twice",
    {
      links: [
        { url: "https://example.com/d" },
        { url: "https://example.com/d" },
      ],
    },
    /links lists https:\/\/example\.com\/d twice/,
  ],
  ["a blank label", { labels: [" "] }, /label name must not be empty/],
])("POST /issues with %s is a 422", async (_, fields, message) => {
  const { status, body } = await send("POST", "/issues", {
    projectId: trl.id,
    title: "bad",
    ...fields,
  });
  expect(status).toBe(422);
  expect(body.error.message).toMatch(message);
});

test("an externalRef already used in its scope is a 409 saying which row has it", async () => {
  const project = await created("/projects", {
    key: projectKey(),
    name: "refs",
    externalRef: "P-JUS-9",
  });
  const dupProject = await send("POST", "/projects", {
    key: projectKey(),
    name: "refs again",
    externalRef: "P-JUS-9",
  });
  expect(dupProject.status).toBe(409);
  expect(dupProject.body.error.message).toBe(
    `externalRef P-JUS-9 is already on project ${project.key} (${project.id}): use that project, or send a different externalRef`,
  );

  const issue = await created("/issues", {
    projectId: project.id,
    title: "linear issue",
    externalRef: "JUS-1",
  });
  const dupIssue = await send("POST", "/issues", {
    projectId: project.id,
    title: "again",
    externalRef: "JUS-1",
  });
  expect(dupIssue.status).toBe(409);
  expect(dupIssue.body.error.message).toBe(
    `externalRef JUS-1 is already on issue ${issue.key} (${issue.id}): update that issue, or send a different externalRef`,
  );
  // unique within the project only
  await created("/issues", {
    projectId: trl.id,
    title: "same ref elsewhere",
    externalRef: "JUS-1",
  });

  const comment = await created(`/issues/${issue.id}/comments`, {
    body: "from linear",
    externalRef: "c-1",
  });
  expect(comment.externalRef).toBe("c-1");
  const dupComment = await send("POST", `/issues/${issue.id}/comments`, {
    body: "again",
    externalRef: "c-1",
  });
  expect(dupComment.status).toBe(409);
  expect(dupComment.body.error.message).toMatch(
    /^externalRef c-1 is already on comment \S+ of this issue/,
  );
});

test("POST /projects/:id/labels creates a label; a name taken in any case is a 409", async () => {
  const project = await created("/projects", {
    key: projectKey(),
    name: "explicit labels",
  });
  const label = await created(`/projects/${project.key}/labels`, {
    name: "Feature",
  });
  expect(label).toEqual({
    id: expect.any(String),
    projectId: project.id,
    name: "Feature",
    createdAt: expect.any(String),
  });
  expect(published.at(-1)).toMatchObject({
    action: "label.created",
    subjectType: "label",
    subjectId: label.id,
    projectId: project.id,
  });
  const dup = await send("POST", `/projects/${project.id}/labels`, {
    name: "feature",
  });
  expect(dup.status).toBe(409);
  expect(dup.body.error.message).toBe(
    `project ${project.key} already has the label "Feature": use it as it is, since label names match ignoring the case of A-Z`,
  );
  const list = await send("GET", `/projects/${project.id}/labels`);
  expect(list.body).toEqual({ items: [label], nextCursor: null });
});

test("labels routes on an unknown project are 404s", async () => {
  expect((await send("GET", "/projects/NOPE/labels")).status).toBe(404);
  expect(
    (await send("POST", "/projects/NOPE/labels", { name: "x" })).status,
  ).toBe(404);
});
