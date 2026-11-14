import { beforeAll, describe, expect, test } from "vitest";
import { atFakeTime, atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { request, signIn, owner, addMember, addProject, addBot } =
  setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

async function get(path: string, cookie: string) {
  const res = await request("GET", `/api/web${path}`, { key: null, cookie });
  return { status: res.status, body: (await res.json()) as Body };
}

const bot = (path: string, json: unknown, key?: string) =>
  request("POST", `/api/v1${path}`, { json, key });

async function fileIssues(projectId: string, statuses: string[]) {
  for (const [i, status] of statuses.entries()) {
    const res = await bot("/issues", { projectId, title: `issue ${i}` });
    const { id } = (await res.json()) as { id: string };
    if (status !== "open") {
      await request("PATCH", `/api/v1/issues/${id}`, { json: { status } });
    }
  }
}

test("GET /projects lists only the member's projects, each with open and in-progress counts and no status update yet", async () => {
  const mine = addProject("Mine");
  const theirs = addProject("Theirs");
  await fileIssues(mine.id, [
    "open",
    "open",
    "in_progress",
    "done",
    "canceled",
  ]);
  await fileIssues(theirs.id, ["open"]);
  const cookie = await addMember("pat", [mine.id]);

  const { status, body } = await get("/projects", cookie);

  expect(status).toBe(200);
  expect(body.items).toEqual([
    {
      key: mine.key,
      name: "Mine",
      description: "",
      health: null,
      latestStatusUpdate: null,
      openCount: 2,
      inProgressCount: 1,
      updatedAt: expect.any(String),
    },
  ]);
});

test("a project's health and latest status update are its newest update's, with the author's name and kind", async () => {
  const p = addProject("Health");
  const reporter = addBot("reporter");
  await atFakeTimeAsync([
    () =>
      bot(`/projects/${p.id}/status-updates`, {
        body: "fine",
        health: "on_track",
      }),
    () =>
      bot(
        `/projects/${p.id}/status-updates`,
        { body: "slipping", health: "at_risk" },
        reporter.key,
      ),
  ]);
  const { body } = await get(`/projects/${p.key}`, await signIn(owner));
  expect(body).toMatchObject({
    key: p.key,
    health: "at_risk",
    latestStatusUpdate: {
      body: "slipping",
      health: "at_risk",
      author: {
        id: reporter.actor.id,
        name: "reporter",
        kind: "bot",
        photoUrl: null,
        title: null,
      },
      sourceAuthor: null,
    },
  });
});

test("a project's updatedAt is its newest issue update when that is later than the project's own", async () => {
  const [p] = atFakeTime([() => addProject("Fresh")]);
  if (!p) throw new Error("no project");
  const created = await bot("/issues", { projectId: p.id, title: "x" });
  const issue = (await created.json()) as { updatedAt: string };
  const { body } = await get(`/projects/${p.key}`, await signIn(owner));
  expect(body.updatedAt).toBe(issue.updatedAt);
});

test("GET /projects/:key takes the key in any case", async () => {
  const p = addProject("Case");
  const { status, body } = await get(
    `/projects/${p.key.toLowerCase()}`,
    await signIn(owner),
  );
  expect(status).toBe(200);
  expect(body.key).toBe(p.key);
});

test("GET /projects/:key/status-updates pages newest first", async () => {
  const p = addProject("Updates");
  await atFakeTimeAsync(
    ["one", "two", "three"].map(
      (body) => () =>
        bot(`/projects/${p.id}/status-updates`, { body, health: "on_track" }),
    ),
  );
  const cookie = await signIn(owner);
  const first = await get(`/projects/${p.key}/status-updates?limit=2`, cookie);
  expect(first.body.items.map((u: Body) => u.body)).toEqual(["three", "two"]);
  const rest = await get(
    `/projects/${p.key}/status-updates?limit=2&cursor=${first.body.nextCursor}`,
    cookie,
  );
  expect(rest.body).toMatchObject({
    items: [{ body: "one" }],
    nextCursor: null,
  });
});

describe("GET /projects/:key/issues", () => {
  let p: { id: string; key: string };
  let cookie = "";
  beforeAll(async () => {
    p = addProject("List");
    const other = addProject("Other");
    const assignee = addBot("assignee");
    await atFakeTimeAsync([
      () => fileIssues(p.id, ["open"]),
      () => fileIssues(p.id, ["in_progress", "done"]),
      () => fileIssues(other.id, ["open", "open", "open"]),
    ]);
    const res = await bot("/issues", {
      projectId: p.id,
      title: "labelled",
      priority: 2,
      labels: ["b", "a"],
      assigneeId: assignee.actor.id,
    });
    expect(res.status).toBe(201);
    cookie = await addMember("lister", [p.id]);
  });

  test("lists the project's issues newest first as display rows, with per-status counts", async () => {
    const { status, body } = await get(`/projects/${p.key}/issues`, cookie);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(4);
    expect(body.items[0]).toEqual({
      key: `${p.key}-4`,
      title: "labelled",
      status: "open",
      priority: 2,
      labels: ["a", "b"],
      assignee: {
        id: expect.any(String),
        name: "assignee",
        kind: "bot",
        photoUrl: null,
        title: null,
      },
      updatedAt: expect.any(String),
    });
    expect(body.items[3]).toMatchObject({ key: `${p.key}-1`, assignee: null });
    expect(body.counts).toEqual({
      all: 4,
      open: 2,
      in_progress: 1,
      done: 1,
      canceled: 0,
    });
    expect(body.nextCursor).toBeNull();
  });

  test("filters by status and keeps the counts of every status", async () => {
    const { body } = await get(`/projects/${p.key}/issues?status=open`, cookie);
    expect(body.items.map((i: Body) => i.key)).toEqual([
      `${p.key}-4`,
      `${p.key}-1`,
    ]);
    expect(body.counts.all).toBe(4);
  });

  test("pages with limit and cursor", async () => {
    const first = await get(`/projects/${p.key}/issues?limit=3`, cookie);
    expect(first.body.items).toHaveLength(3);
    const rest = await get(
      `/projects/${p.key}/issues?limit=3&cursor=${first.body.nextCursor}`,
      cookie,
    );
    expect(rest.body).toMatchObject({
      items: [{ key: `${p.key}-1` }],
      nextCursor: null,
    });
  });
});
