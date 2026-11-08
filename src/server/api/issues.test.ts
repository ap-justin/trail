import { beforeAll, expect, test } from "vitest";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";

const { bot, request } = setupTestApp();

let projectId = "";
beforeAll(async () => {
  const res = await request("POST", "/api/v1/projects", {
    json: { key: "ISS", name: "issues" },
  });
  projectId = ((await res.json()) as { id: string }).id;
});

type IssueBody = { id: string; title: string; status: string };

async function createIssue(json: Record<string, unknown>) {
  const res = await request("POST", "/api/v1/issues", {
    json: { projectId, ...json },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as IssueBody;
}

test("POST /issues opens an unassigned issue and returns 201", async () => {
  const res = await request("POST", "/api/v1/issues", {
    json: { projectId, title: "first" },
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    id: expect.any(String),
    key: "ISS-1",
    number: 1,
    projectId,
    title: "first",
    description: "",
    status: "open",
    priority: 0,
    estimate: null,
    labels: [],
    links: [],
    assigneeId: null,
    externalRef: null,
    sourceAuthor: null,
    sourceStatus: null,
    createdBy: bot.actor.id,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    completedAt: null,
  });
});

test("POST /issues on an unknown project is a 404", async () => {
  const res = await request("POST", "/api/v1/issues", {
    json: { projectId: "nope", title: "lost" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: {
      code: "not_found",
      message:
        "no project nope: pass the id or key (like TRL) of an existing project",
    },
  });
});

test("GET /issues/:id returns the issue; an unknown id is a 404", async () => {
  const { id } = await createIssue({ title: "fetch me" });
  const res = await request("GET", `/api/v1/issues/${id}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id, title: "fetch me" });
  expect((await request("GET", "/api/v1/issues/nope")).status).toBe(404);
});

test("PATCH /issues/:id moves status, assigns and unassigns", async () => {
  const { id } = await createIssue({ title: "move me" });
  const assigned = await request("PATCH", `/api/v1/issues/${id}`, {
    json: { status: "in_progress", assigneeId: bot.actor.id },
  });
  expect(assigned.status).toBe(200);
  expect(await assigned.json()).toMatchObject({
    status: "in_progress",
    assigneeId: bot.actor.id,
  });

  const unassigned = await request("PATCH", `/api/v1/issues/${id}`, {
    json: { status: "done", assigneeId: null },
  });
  expect(await unassigned.json()).toMatchObject({
    status: "done",
    assigneeId: null,
    completedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
  });

  const reopened = await request("PATCH", `/api/v1/issues/${id}`, {
    json: { status: "open" },
  });
  expect(await reopened.json()).toMatchObject({
    status: "open",
    completedAt: null,
  });
});

test("PATCH /issues/:id with an unknown status is a 422 and changes nothing", async () => {
  const { id } = await createIssue({ title: "stay open" });
  const res = await request("PATCH", `/api/v1/issues/${id}`, {
    json: { status: "closed" },
  });
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: {
      code: "validation_failed",
      message: expect.stringMatching(/^status: /),
    },
  });
  const after = await request("GET", `/api/v1/issues/${id}`);
  expect(((await after.json()) as IssueBody).status).toBe("open");
});

test("PATCH /issues/:id assigning an unknown actor is a 422", async () => {
  const { id } = await createIssue({ title: "nobody" });
  const res = await request("PATCH", `/api/v1/issues/${id}`, {
    json: { assigneeId: "ghost" },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "validation_failed",
  );
});

test("GET /issues filters by project, status and assignee", async () => {
  const other = await request("POST", "/api/v1/projects", {
    json: { key: projectKey(), name: "filters" },
  });
  const otherId = ((await other.json()) as { id: string }).id;
  const titles = async (query: string) => {
    const res = await request("GET", `/api/v1/issues?${query}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: IssueBody[] };
    return page.items.map((i) => i.title);
  };

  const [open, mine] = (await atFakeTimeAsync([
    () => createIssue({ projectId: otherId, title: "f-open" }),
    () =>
      createIssue({
        projectId: otherId,
        title: "f-mine",
        assigneeId: bot.actor.id,
      }),
  ])) as [IssueBody, IssueBody];
  await request("PATCH", `/api/v1/issues/${mine.id}`, {
    json: { status: "in_progress" },
  });

  expect(await titles(`projectId=${otherId}`)).toEqual(["f-mine", "f-open"]);
  expect(await titles(`projectId=${otherId}&status=open`)).toEqual([
    open.title,
  ]);
  expect(
    await titles(`projectId=${otherId}&assigneeId=${bot.actor.id}`),
  ).toEqual(["f-mine"]);
});

test("GET /issues?status=closed is a 422", async () => {
  const res = await request("GET", "/api/v1/issues?status=closed");
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: {
      code: "validation_failed",
      message: expect.stringMatching(/^status: /),
    },
  });
});

async function freshProject(name: string) {
  const res = await request("POST", "/api/v1/projects", {
    json: { key: projectKey(), name },
  });
  return ((await res.json()) as { id: string }).id;
}

type IssuePage = { items: IssueBody[]; nextCursor: string | null };

async function issuePage(query: string) {
  const res = await request("GET", `/api/v1/issues?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as IssuePage;
}

test("GET /issues pages through nextCursor without repeats", async () => {
  const pagingId = await freshProject("paging");
  await atFakeTimeAsync(
    ["p1", "p2", "p3"].map(
      (title) => () => createIssue({ projectId: pagingId, title }),
    ),
  );
  const first = await issuePage(`projectId=${pagingId}&limit=2`);
  expect(first.items.map((i) => i.title)).toEqual(["p3", "p2"]);
  const second = await issuePage(
    `projectId=${pagingId}&limit=2&cursor=${first.nextCursor}`,
  );
  expect(second.items.map((i) => i.title)).toEqual(["p1"]);
  expect(second.nextCursor).toBeNull();
});

test("GET /issues ends on a null cursor when the count is a multiple of the limit", async () => {
  const exactId = await freshProject("exact");
  await atFakeTimeAsync(
    ["e1", "e2", "e3", "e4"].map(
      (title) => () => createIssue({ projectId: exactId, title }),
    ),
  );
  const first = await issuePage(`projectId=${exactId}&limit=2`);
  expect(first.items.map((i) => i.title)).toEqual(["e4", "e3"]);
  const second = await issuePage(
    `projectId=${exactId}&limit=2&cursor=${first.nextCursor}`,
  );
  expect(second.items.map((i) => i.title)).toEqual(["e2", "e1"]);
  expect(second.nextCursor).toBeNull();
});

test("GET /issues on a project with no issues is one empty page", async () => {
  const emptyId = await freshProject("empty");
  expect(await issuePage(`projectId=${emptyId}`)).toEqual({
    items: [],
    nextCursor: null,
  });
});

test("GET /issues accepts the limit bounds 1 and 200", async () => {
  const boundsId = await freshProject("bounds");
  await atFakeTimeAsync(
    ["b1", "b2"].map(
      (title) => () => createIssue({ projectId: boundsId, title }),
    ),
  );
  const one = await issuePage(`projectId=${boundsId}&limit=1`);
  expect(one.items.map((i) => i.title)).toEqual(["b2"]);
  expect(one.nextCursor).not.toBeNull();
  const max = await issuePage(`projectId=${boundsId}&limit=200`);
  expect(max.items.map((i) => i.title)).toEqual(["b2", "b1"]);
  expect(max.nextCursor).toBeNull();
});
