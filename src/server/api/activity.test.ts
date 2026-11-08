import { beforeAll, describe, expect, test } from "vitest";
import { activityEvent } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, bot, published, request } = setupTestApp();

type Event = { id: string; action: string; actorId: string; projectId: string };
type Page = { items: Event[]; nextCursor: string | null };

const eventRows = () => db.select().from(activityEvent).all();

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function newProject(name: string, key?: string) {
  return json<{ id: string }>(
    request("POST", "/api/v1/projects", { json: { name }, key }),
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
      () => ({ name: "p" }),
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
  const other = createBot(db, "other");
  const a = await newProject("activity-a");
  const b = await newProject("activity-b", other.key);
  await request("PATCH", `/api/v1/projects/${a.id}`, {
    json: { description: "changed" },
  });

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
      payload: { name: "activity-b", description: "" },
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
  expect(all.items[0]?.action).toBe("project.updated");
});

test("GET /activity with a bad cursor is a 422", async () => {
  const res = await request("GET", "/api/v1/activity?cursor=%21%21");
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: { code: "validation_failed", message: "cursor is invalid" },
  });
});
