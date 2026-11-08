import { expect, test } from "vitest";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";

const { app, bot, request } = setupTestApp();

const isoTimestamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);

test("POST /projects creates a project as the calling bot and returns 201", async () => {
  const res = await request("POST", "/api/v1/projects", {
    json: { key: "TRL", name: "trail", description: "issue tracker" },
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    id: expect.any(String),
    key: "TRL",
    name: "trail",
    description: "issue tracker",
    externalRef: null,
    createdBy: bot.actor.id,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  });
});

async function createProject(name: string) {
  const res = await request("POST", "/api/v1/projects", {
    json: { key: projectKey(), name },
  });
  return (await res.json()) as { id: string; name: string };
}

test("GET /projects/:id returns the project; an unknown id is a 404", async () => {
  const { id } = await createProject("get-me");
  const res = await request("GET", `/api/v1/projects/${id}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id, name: "get-me" });

  const missing = await request("GET", "/api/v1/projects/nope");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: {
      code: "not_found",
      message:
        "no project nope: pass the id or key (like TRL) of an existing project",
    },
  });
});

test("PATCH /projects/:id changes only the fields sent", async () => {
  const { id } = await createProject("before");
  const res = await request("PATCH", `/api/v1/projects/${id}`, {
    json: { description: "now described" },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    id,
    name: "before",
    description: "now described",
  });

  const missing = await request("PATCH", "/api/v1/projects/nope", {
    json: { name: "x" },
  });
  expect(missing.status).toBe(404);
});

const validationFailed = (message: unknown) => ({
  error: { code: "validation_failed", message },
});

test.each([
  ["a missing required field", {}, /^name: /],
  ["a field of the wrong type", { name: 7 }, /^name: /],
  ["an empty name", { name: "" }, /^name: /],
  ["a field the schema does not know", { name: "x", nmae: "y" }, /nmae/],
])(
  "POST /projects with %s is a 422 naming the field",
  async (_, json, message) => {
    const res = await request("POST", "/api/v1/projects", { json });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(
      validationFailed(expect.stringMatching(message)),
    );
  },
);

test("a blank name the service rejects is a 422 in the same shape", async () => {
  const res = await request("POST", "/api/v1/projects", {
    json: { key: projectKey(), name: "   " },
  });
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual(validationFailed("name must not be empty"));
});

test("a write with no body is a 422", async () => {
  const res = await request("POST", "/api/v1/projects");
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual(validationFailed(expect.any(String)));
});

test("a body sent without a JSON Content-Type is a 415, not an empty patch", async () => {
  const { id } = await createProject("typed");
  const res = await app.request(`/api/v1/projects/${id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "text/plain",
    },
    body: JSON.stringify({ name: "renamed" }),
  });
  expect(res.status).toBe(415);
  expect(await res.json()).toEqual({
    error: { code: "unsupported_media_type", message: expect.any(String) },
  });
  const after = await request("GET", `/api/v1/projects/${id}`);
  expect(await after.json()).toMatchObject({ name: "typed" });
});

test("malformed JSON is a 400 in the shared shape", async () => {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "application/json",
    },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "bad_request", message: expect.any(String) },
  });
});

test.each([
  ["cursor=garbage", "cursor is invalid"],
  ["limit=0", expect.stringMatching(/^limit: /)],
  ["limit=201", expect.stringMatching(/^limit: /)],
  ["limit=two", expect.stringMatching(/^limit: /)],
])("GET /projects?%s is a 422", async (query, message) => {
  const res = await request("GET", `/api/v1/projects?${query}`);
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual(validationFailed(message));
});

test("GET /projects pages newest first through nextCursor", async () => {
  await atFakeTimeAsync(
    ["page-a", "page-b", "page-c"].map((name) => () => createProject(name)),
  );
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = cursor ? `&cursor=${cursor}` : "";
    const res = await request("GET", `/api/v1/projects?limit=2${query}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: { name: string }[];
      nextCursor: string | null;
    };
    expect(page.items.length).toBeLessThanOrEqual(2);
    seen.push(...page.items.map((p) => p.name));
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null);
  expect(pages).toBe(Math.ceil(seen.length / 2));
  expect(new Set(seen).size).toBe(seen.length);
  // earlier tests' projects were written at real time, after these fake-stamped ones
  expect(seen.filter((n) => n.startsWith("page-"))).toEqual([
    "page-c",
    "page-b",
    "page-a",
  ]);
});

test("GET /projects accepts the limit bounds 1 and 200", async () => {
  await createProject("bounds");
  for (const limit of [1, 200]) {
    const res = await request("GET", `/api/v1/projects?limit=${limit}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[] };
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.items.length).toBeLessThanOrEqual(limit);
  }
});
