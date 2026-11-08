import { beforeAll, describe, expect, test, vi } from "vitest";
import { activityEvent } from "../db/schema.js";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";

const { db, bot, addBot, published, request } = setupTestApp();

type Event = { id: string; action: string; actorId: string; projectId: string };
type Page = { items: Event[]; nextCursor: string | null };

const eventRows = () => db.select().from(activityEvent).all();

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const json_ = (res: Response | Promise<Response>) =>
  // biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
  json<Record<string, any>>(res);

async function newProject(name: string, key?: string) {
  return json<{ id: string }>(
    request("POST", "/api/v1/projects", {
      json: { key: projectKey(), name },
      key,
    }),
  );
}

describe("each REST write yields exactly one activity_event and one bus event", () => {
  let projectId = "";
  let issueId = "";
  beforeAll(async () => {
    projectId = (await newProject("writes")).id;
    issueId = (
      await json<{ id: string }>(
        request("POST", "/api/v1/issues", {
          json: { projectId, title: "target" },
        }),
      )
    ).id;
  });

  // thunks: the rows are built before beforeAll has created the ids they name
  test.each([
    [
      "POST /projects",
      "POST",
      () => "/api/v1/projects",
      () => ({ key: projectKey(), name: "p" }),
      "project.created",
    ],
    [
      "PATCH /projects/:id",
      "PATCH",
      () => `/api/v1/projects/${projectId}`,
      () => ({ name: "renamed" }),
      "project.updated",
    ],
    [
      "POST /issues",
      "POST",
      () => "/api/v1/issues",
      () => ({ projectId, title: "t" }),
      "issue.created",
    ],
    [
      "PATCH /issues/:id",
      "PATCH",
      () => `/api/v1/issues/${issueId}`,
      () => ({ status: "done" }),
      "issue.updated",
    ],
    [
      "POST /issues/:id/comments",
      "POST",
      () => `/api/v1/issues/${issueId}/comments`,
      () => ({ body: "hi" }),
      "comment.created",
    ],
  ])("%s", async (_, method, path, body, action) => {
    const rowsBefore = eventRows().length;
    const publishedBefore = published.length;

    const res = await request(method, path(), { json: body() });
    expect(res.status).toBeLessThan(300);

    const added = eventRows().slice(rowsBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action, actorId: bot.actor.id });
    expect(published.slice(publishedBefore)).toEqual(added);
  });

  test("a failed write (unknown project) yields neither", async () => {
    const rowsBefore = eventRows().length;
    const publishedBefore = published.length;
    const res = await request("POST", "/api/v1/issues", {
      json: { projectId: "nope", title: "lost" },
    });
    expect(res.status).toBe(404);
    expect(eventRows()).toHaveLength(rowsBefore);
    expect(published).toHaveLength(publishedBefore);
  });
});

test("GET /activity lists newest first, filters by project and actor, and pages", async () => {
  const other = addBot("other");
  const [a, b] = await atFakeTimeAsync([
    () => newProject("activity-a"),
    () => newProject("activity-b", other.key),
  ]);
  if (!a || !b) throw new Error("projects not created");
  await atFakeTimeAsync([
    () =>
      request("PATCH", `/api/v1/projects/${a.id}`, {
        json: { description: "changed" },
      }),
  ]);

  const byProject = await json<Page>(
    request("GET", `/api/v1/activity?projectId=${a.id}`),
  );
  expect(byProject.items.map((e) => e.action)).toEqual([
    "project.updated",
    "project.created",
  ]);

  const byActor = await json<Page>(
    request("GET", `/api/v1/activity?actorId=${other.actor.id}`),
  );
  expect(byActor.items).toEqual([
    expect.objectContaining({
      action: "project.created",
      projectId: b.id,
      actorId: other.actor.id,
      subjectType: "project",
      subjectId: b.id,
      payload: expect.objectContaining({ name: "activity-b", description: "" }),
      createdAt: expect.any(String),
    }),
  ]);

  const all = await json<Page>(request("GET", "/api/v1/activity?limit=200"));
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const suffix: string = cursor === null ? "" : `&cursor=${cursor}`;
    const page: Page = await json<Page>(
      request("GET", `/api/v1/activity?limit=3${suffix}`),
    );
    seen.push(...page.items.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(seen).toEqual(all.items.map((e) => e.id));
});

test("each write is attributed to the bot whose key made it", async () => {
  const first = addBot("attr-first");
  const second = addBot("attr-second");
  const asFirst = (method: string, path: string, json?: unknown) =>
    json_(request(method, path, { json, key: first.key }));
  const asSecond = (method: string, path: string, json?: unknown) =>
    json_(request(method, path, { json, key: second.key }));

  const project = await asFirst("POST", "/api/v1/projects", {
    key: projectKey(),
    name: "attr",
  });
  const issue = await asSecond("POST", "/api/v1/issues", {
    projectId: project.id,
    title: "filed by second",
  });
  const comment = await asFirst("POST", `/api/v1/issues/${issue.id}/comments`, {
    body: "from first",
  });
  const reply = await asSecond("POST", `/api/v1/issues/${issue.id}/comments`, {
    body: "from second",
  });

  expect(project.createdBy).toBe(first.actor.id);
  expect(issue.createdBy).toBe(second.actor.id);
  expect(comment.authorId).toBe(first.actor.id);
  expect(reply.authorId).toBe(second.actor.id);

  const events = await json<Page>(
    request("GET", `/api/v1/activity?projectId=${project.id}&limit=200`),
  );
  expect(
    events.items
      .map((e) => `${e.action}:${e.actorId}`)
      .sort((x, y) => x.localeCompare(y)),
  ).toEqual(
    [
      `project.created:${first.actor.id}`,
      `issue.created:${second.actor.id}`,
      `comment.created:${first.actor.id}`,
      `comment.created:${second.actor.id}`,
    ].sort((x, y) => x.localeCompare(y)),
  );
});

test("an update is attributed to the bot that PATCHed, not the one that created the row", async () => {
  const author = addBot("upd-author");
  const editor = addBot("upd-editor");
  const as = (
    who: typeof author,
    method: string,
    path: string,
    json?: unknown,
  ) => json_(request(method, path, { json, key: who.key }));

  const project = await as(author, "POST", "/api/v1/projects", {
    key: projectKey(),
    name: "upd",
  });
  const issue = await as(author, "POST", "/api/v1/issues", {
    projectId: project.id,
    title: "upd",
  });
  const publishedBefore = published.length;

  await as(editor, "PATCH", `/api/v1/projects/${project.id}`, { name: "upd2" });
  await as(editor, "PATCH", `/api/v1/issues/${issue.id}`, { status: "done" });

  const events = await json<Page>(
    request("GET", `/api/v1/activity?projectId=${project.id}&limit=200`),
  );
  const updates = events.items.filter((e) => e.action.endsWith(".updated"));
  expect(
    updates
      .map((e) => `${e.action}:${e.actorId}`)
      .sort((x, y) => x.localeCompare(y)),
  ).toEqual([
    `issue.updated:${editor.actor.id}`,
    `project.updated:${editor.actor.id}`,
  ]);
  expect(
    published
      .slice(publishedBefore)
      .map((e) => `${e.action}:${e.actorId}`)
      .sort((x, y) => x.localeCompare(y)),
  ).toEqual([
    `issue.updated:${editor.actor.id}`,
    `project.updated:${editor.actor.id}`,
  ]);
  expect(project.createdBy).toBe(author.actor.id);
});

test("GET /activity with a bad cursor is a 422", async () => {
  const res = await request("GET", "/api/v1/activity?cursor=%21%21");
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: {
      code: "validation_failed",
      message: expect.stringMatching(/^cursor is invalid: /),
    },
  });
});

describe("GET /activity?after= resumes the feed oldest first", () => {
  const feed = (query: string) =>
    json<Page>(request("GET", `/api/v1/activity?${query}`));

  test("from the start, page by page, then the same cursor while nothing is new", async () => {
    const project = await newProject("resume");
    const issue = await json_(
      request("POST", "/api/v1/issues", {
        json: { projectId: project.id, title: "resumed" },
      }),
    );
    await request("POST", `/api/v1/issues/${issue.id}/comments`, {
      json: { body: "one" },
    });
    const scope = `projectId=${project.id}`;

    const first = await feed(`${scope}&after=&limit=2`);
    expect(first.items.map((e) => e.action)).toEqual([
      "project.created",
      "issue.created",
    ]);
    const second = await feed(`${scope}&after=${first.nextCursor}&limit=2`);
    expect(second.items.map((e) => e.action)).toEqual(["comment.created"]);
    const idle = await feed(`${scope}&after=${second.nextCursor}&limit=2`);
    expect(idle).toEqual({ items: [], nextCursor: second.nextCursor });

    await request("PATCH", `/api/v1/issues/${issue.id}`, {
      json: { status: "done" },
    });
    const resumed = await feed(`${scope}&after=${idle.nextCursor}`);
    expect(resumed.items.map((e) => e.action)).toEqual(["issue.updated"]);
    expect(resumed.nextCursor).not.toBe(idle.nextCursor);
  });

  test("an event stamped earlier than the cursor's, written later, is still returned", async () => {
    const [project] = await atFakeTimeAsync([() => newProject("backdated")]);
    const projectId = (project as { id: string }).id;
    const scope = `projectId=${projectId}`;
    const { nextCursor } = await feed(`${scope}&after=`);
    const cursorAt = eventRows()
      .filter((e) => e.projectId === projectId)
      .map((e) => e.createdAt.getTime())[0] as number;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(cursorAt - 60_000));
      await request("POST", "/api/v1/issues", {
        json: { projectId, title: "late arrival" },
      });
    } finally {
      vi.useRealTimers();
    }

    const late = eventRows().filter(
      (e) => e.action === "issue.created" && e.projectId === projectId,
    );
    expect(late.map((e) => e.createdAt.getTime() < cursorAt)).toEqual([true]);
    const resumed = await feed(`${scope}&after=${nextCursor}`);
    expect(resumed.items.map((e) => e.action)).toEqual(["issue.created"]);
  });

  test("an empty feed still hands back a cursor to poll from", async () => {
    const quiet = addBot("quiet");
    const empty = await feed(`actorId=${quiet.actor.id}&after=`);
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toEqual(expect.any(String));
    await newProject("first words", quiet.key);
    const next = await feed(
      `actorId=${quiet.actor.id}&after=${empty.nextCursor}`,
    );
    expect(next.items.map((e) => e.action)).toEqual(["project.created"]);
  });

  test("a cursor used under other filters is a 422 that says to reuse them or drop it", async () => {
    const a = await newProject("bound a");
    const b = await newProject("bound b");
    const { nextCursor } = await feed(`projectId=${a.id}&after=`);
    for (const query of [
      `projectId=${b.id}&after=${nextCursor}`,
      `after=${nextCursor}`,
      `projectId=${a.id}&actorId=${bot.actor.id}&after=${nextCursor}`,
      `projectId=${b.id}&cursor=${nextCursor}`,
    ]) {
      const res = await request("GET", `/api/v1/activity?${query}`);
      expect(res.status, query).toBe(422);
      expect(await res.json()).toEqual({
        error: {
          code: "validation_failed",
          message: expect.stringMatching(
            new RegExp(
              `^cursor was issued for projectId=${a.id}, actorId=\\(none\\) but this request has .*: repeat the cursor's filters, or drop the cursor to start over$`,
            ),
          ),
        },
      });
    }
  });

  test("a cursor issued under a project's id is accepted under its key", async () => {
    const res = await request("POST", "/api/v1/projects", {
      json: { key: "FEED", name: "by key" },
    });
    const project = (await res.json()) as { id: string };
    const { nextCursor } = await feed(`projectId=${project.id}&after=`);
    const again = await request(
      "GET",
      `/api/v1/activity?projectId=FEED&after=${nextCursor}`,
    );
    expect(again.status).toBe(200);
  });

  test.each([
    ["an after page's cursor sent as cursor", "after=", "cursor", "after"],
    ["a cursor page's cursor sent as after", "limit=1", "after", "cursor"],
  ])(
    "%s is a 422 that names the parameter to send it on",
    async (_, firstPage, sentAs, sendOn) => {
      const project = await newProject("direction");
      await request("POST", "/api/v1/issues", {
        json: { projectId: project.id, title: "second event" },
      });
      const scope = `projectId=${project.id}`;
      const { nextCursor } = await feed(`${scope}&${firstPage}`);
      expect(nextCursor).toEqual(expect.any(String));

      const res = await request(
        "GET",
        `/api/v1/activity?${scope}&${sentAs}=${nextCursor}`,
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: {
          code: "validation_failed",
          message: expect.stringMatching(
            new RegExp(`: send it as ${sendOn}, not as ${sentAs}$`),
          ),
        },
      });
    },
  );

  test("cursor and after together are a 422", async () => {
    const res = await request("GET", "/api/v1/activity?after=&cursor=x");
    expect(res.status).toBe(422);
  });
});

test.each([
  ["newest first", ""],
  ["resuming with after", "&after="],
])(
  "GET /activity %s takes limit 1 to 200 and refuses 0 and 201 with a 422",
  async (_, mode) => {
    for (const limit of [1, 200]) {
      const res = await request(
        "GET",
        `/api/v1/activity?limit=${limit}${mode}`,
      );
      expect(res.status, `limit ${limit}`).toBe(200);
    }
    for (const limit of [0, 201]) {
      const res = await request(
        "GET",
        `/api/v1/activity?limit=${limit}${mode}`,
      );
      expect(res.status, `limit ${limit}`).toBe(422);
    }
  },
);
