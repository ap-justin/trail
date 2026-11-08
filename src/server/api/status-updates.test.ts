import { beforeAll, expect, test } from "vitest";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { bot, addBot, request, published } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

let project: Body;
beforeAll(async () => {
  const res = await request("POST", "/api/v1/projects", {
    json: { key: "SUP", name: "status" },
  });
  project = (await res.json()) as Body;
});

const post = (json: unknown, key?: string) =>
  request("POST", `/api/v1/projects/${project.key}/status-updates`, {
    json,
    key,
  });

test("POST /projects/:id/status-updates posts as the calling bot with one event", async () => {
  const before = published.length;
  const res = await post({ body: "on schedule", health: "on_track" });
  expect(res.status).toBe(201);
  const update = (await res.json()) as Body;
  expect(update).toEqual({
    id: expect.any(String),
    projectId: project.id,
    authorId: bot.actor.id,
    body: "on schedule",
    health: "on_track",
    externalRef: null,
    createdAt: expect.any(String),
  });
  expect(published.slice(before)).toEqual([
    expect.objectContaining({
      action: "status_update.created",
      subjectType: "status_update",
      subjectId: update.id,
      projectId: project.id,
      actorId: bot.actor.id,
      payload: { body: "on schedule", health: "on_track", externalRef: null },
    }),
  ]);
});

test("GET /projects/:id/status-updates lists newest first, paged", async () => {
  const other = addBot("status other");
  await atFakeTimeAsync([
    () => post({ body: "slipping", health: "at_risk" }),
    () => post({ body: "blocked", health: "off_track" }, other.key),
    () => post({ body: "recovered", health: "on_track", externalRef: "u-3" }),
  ]);
  const first = await request(
    "GET",
    `/api/v1/projects/${project.id}/status-updates?limit=2`,
  );
  expect(first.status).toBe(200);
  const page = (await first.json()) as Body;
  expect(page.items.map((u: Body) => [u.body, u.health])).toEqual([
    ["on schedule", "on_track"],
    ["recovered", "on_track"],
  ]);
  const rest = (await (
    await request(
      "GET",
      `/api/v1/projects/${project.id}/status-updates?limit=2&cursor=${page.nextCursor}`,
    )
  ).json()) as Body;
  expect(rest.items.map((u: Body) => [u.body, u.authorId])).toEqual([
    ["blocked", other.actor.id],
    ["slipping", bot.actor.id],
  ]);
  expect(rest.nextCursor).toBeNull();
});

test.each([
  ["an unknown health", { body: "x", health: "fine" }, /^health: /],
  ["no body", { health: "on_track" }, /^body: /],
  [
    "a blank body",
    { body: "  ", health: "on_track" },
    /body must not be empty/,
  ],
])("a status update with %s is a 422", async (_, json, message) => {
  const res = await post(json);
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(message);
});

test("an externalRef used on another of the project's updates is a 409", async () => {
  await post({ body: "a", health: "on_track", externalRef: "u-dup" });
  const res = await post({
    body: "b",
    health: "on_track",
    externalRef: "u-dup",
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^externalRef u-dup is already on status update \S+ of project SUP/,
  );
});

test("status updates of an unknown project are 404s", async () => {
  const path = "/api/v1/projects/NOPE/status-updates";
  expect((await request("GET", path)).status).toBe(404);
  const res = await request("POST", path, {
    json: { body: "x", health: "on_track" },
  });
  expect(res.status).toBe(404);
});
