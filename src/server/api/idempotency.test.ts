import { beforeAll, describe, expect, test } from "vitest";
import { activityEvent } from "../db/schema.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, app, bot, addBot, request, published } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

function post(
  path: string,
  json: unknown,
  idempotencyKey: string,
  key = bot.key,
) {
  return app.request(`/api/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(json),
  });
}

const eventCount = () => db.select().from(activityEvent).all().length;

let project: Body;
let issue: Body;
beforeAll(async () => {
  project = (await (
    await request("POST", "/api/v1/projects", {
      json: { key: "IDEM", name: "idempotency" },
    })
  ).json()) as Body;
  issue = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: project.id, title: "target" },
    })
  ).json()) as Body;
});

describe("a create repeated with its Idempotency-Key returns the first response and writes nothing", () => {
  // thunks: the rows are built before beforeAll has created the ids they name
  test.each([
    ["POST /projects", () => "/projects", () => ({ key: "IDP", name: "p" })],
    [
      "POST /issues",
      () => "/issues",
      () => ({ projectId: project.id, title: "once", labels: ["l"] }),
    ],
    [
      "POST /issues/:id/comments",
      () => `/issues/${issue.id}/comments`,
      () => ({ body: "once" }),
    ],
    [
      "POST /projects/:id/status-updates",
      () => `/projects/${project.id}/status-updates`,
      () => ({ body: "once", health: "on_track" }),
    ],
    [
      "POST /projects/:id/labels",
      () => `/projects/${project.id}/labels`,
      () => ({ name: "once" }),
    ],
  ])("%s", async (name, path, json) => {
    const key = `retry ${name}`;
    const first = await post(path(), json(), key);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const events = eventCount();
    const publishedBefore = published.length;

    const again = await post(path(), json(), key);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(firstBody);
    expect(eventCount()).toBe(events);
    expect(published.length).toBe(publishedBefore);
  });
});

test("the replay is the first response even after the row has changed", async () => {
  const json = { projectId: project.id, title: "original" };
  const first = (await (await post("/issues", json, "changes")).json()) as Body;
  await request("PATCH", `/api/v1/issues/${first.id}`, {
    json: { title: "edited" },
  });
  const again = (await (await post("/issues", json, "changes")).json()) as Body;
  expect(again).toEqual(first);
  expect(again.title).toBe("original");
});

test("a body with its fields in another order is the same request", async () => {
  const first = await post(
    "/issues",
    {
      title: "ordered",
      projectId: project.id,
      labels: ["a", "b"],
      links: [{ title: "PR", url: "https://github.com/o/r/pull/1" }],
    },
    "reordered",
  );
  expect(first.status).toBe(201);
  const events = eventCount();
  const again = await post(
    "/issues",
    {
      links: [{ url: "https://github.com/o/r/pull/1", title: "PR" }],
      labels: ["a", "b"],
      projectId: project.id,
      title: "ordered",
    },
    "reordered",
  );
  expect(again.status).toBe(201);
  expect(await again.json()).toEqual(await first.json());
  expect(eventCount()).toBe(events);
});

test("a reference sent as a key or an id is the same request", async () => {
  const byId = await post(
    "/issues",
    { projectId: project.id, title: "ref" },
    "by ref",
  );
  const byKey = await post(
    "/issues",
    { projectId: "idem", title: "ref" },
    "by ref",
  );
  expect(byKey.status).toBe(201);
  expect(await byKey.json()).toEqual(await byId.json());
});

test("the same key with a different body is a 422 telling the bot to use a new key", async () => {
  await post("/issues", { projectId: project.id, title: "a" }, "reused");
  const events = eventCount();
  const res = await post(
    "/issues",
    { projectId: project.id, title: "b" },
    "reused",
  );
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: {
      code: "idempotency_key_reused",
      message:
        'idempotency key "reused" was already used for a different request body or target: send a new key for a new create, or resend the first request unchanged to get its result',
    },
  });
  expect(eventCount()).toBe(events);
});

test("the same key on another kind of create is a 422 naming the first", async () => {
  await post("/issues", { projectId: project.id, title: "scoped" }, "scoped");
  const res = await post(
    `/issues/${issue.id}/comments`,
    { body: "x" },
    "scoped",
  );
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^idempotency key "scoped" was already used for a different operation \(issue\.create\)/,
  );
});

test("the same key on the same create for another issue is a 422", async () => {
  const other = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: project.id, title: "other" },
    })
  ).json()) as Body;
  await post(`/issues/${issue.id}/comments`, { body: "same" }, "target");
  const res = await post(
    `/issues/${other.id}/comments`,
    { body: "same" },
    "target",
  );
  expect(res.status).toBe(422);
});

test("keys are per bot: another bot's same key is its own create", async () => {
  const other = addBot("idem other");
  const json = { projectId: project.id, title: "mine" };
  const a = (await (await post("/issues", json, "shared")).json()) as Body;
  const b = (await (
    await post("/issues", json, "shared", other.key)
  ).json()) as Body;
  expect(b.id).not.toBe(a.id);
  expect(b.createdBy).toBe(other.actor.id);
});

test("a create that failed stores nothing, so its key can be retried", async () => {
  const key = projectKey();
  await request("POST", "/api/v1/projects", { json: { key, name: "holder" } });
  const failed = await post("/projects", { key, name: "clash" }, "after fail");
  expect(failed.status).toBe(409);
  const fixed = await post(
    "/projects",
    { key: projectKey(), name: "clash" },
    "after fail",
  );
  expect(fixed.status).toBe(201);
});

test("an empty Idempotency-Key is a 422", async () => {
  const res = await post("/issues", { projectId: project.id, title: "e" }, "");
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^idempotency-key: /,
  );
});
