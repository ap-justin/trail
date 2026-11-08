import { describe, expect, test } from "vitest";
import { activityEvent, comment, issue, project } from "../db/schema.js";
import { createBot, createKey, revokeKey } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, app, bot, addBot, published, request } = setupTestApp();

const unauthorized = {
  error: { code: "unauthorized", message: expect.any(String) },
};

describe("a request to /api/v1 without a working bot key is a 401", () => {
  test("no Authorization header", async () => {
    const res = await request("GET", "/api/v1/projects", { key: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toEqual(unauthorized);
  });

  test.each([
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["no token", "Bearer "],
    ["a token with spaces", "Bearer not a token"],
  ])("a malformed header: %s", async (_, authorization) => {
    const res = await app.request("/api/v1/projects", {
      headers: { authorization },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized);
  });

  test("a well-formed key nobody issued", async () => {
    const res = await request("GET", "/api/v1/projects", {
      key: `trail_00000000_${"A".repeat(43)}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized);
  });

  test("a revoked key", async () => {
    const { key } = createBot(db, "retired");
    expect((await request("GET", "/api/v1/projects", { key })).status).toBe(
      200,
    );
    revokeKey(db, key.split("_")[1] as string);
    const res = await request("GET", "/api/v1/projects", { key });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized);
  });

  test("an unknown route is a 401 before it is a 404", async () => {
    const res = await request("GET", "/api/v1/nope", { key: null });
    expect(res.status).toBe(401);
  });
});

test("with a key, an unknown /api/v1 route is a 404 in the shared shape", async () => {
  const res = await request("GET", "/api/v1/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no route GET /api/v1/nope" },
  });
});

test("every operation in the OpenAPI document, but the spec itself, is a 401 without a key", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as { paths: Record<string, Record<string, unknown>> };
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => ({
      method: method.toUpperCase(),
      url: `/api/v1${path.replaceAll("{id}", "some-id")}`,
    })),
  );
  expect(operations.length).toBeGreaterThan(0);
  for (const { method, url } of operations) {
    const json = method === "GET" ? undefined : {};
    const bare = await request(method, url, { key: null, json });
    expect(bare.status, `${method} ${url} without a key`).toBe(401);
    // the same call with a key gets past auth, so the 401 above is the key check
    const keyed = await request(method, url, { json });
    expect(keyed.status, `${method} ${url} with a key`).not.toBe(401);
  }
});

test("revoking one bot's key leaves another's working and keeps the revoked bot's writes attributed", async () => {
  const doomed = addBot("doomed");
  const created = await request("POST", "/api/v1/projects", {
    key: doomed.key,
    json: { key: projectKey(), name: "outlives its key" },
  });
  const { id } = (await created.json()) as { id: string };

  revokeKey(db, doomed.key.split("_")[1] as string);

  expect(
    (await request("GET", "/api/v1/projects", { key: doomed.key })).status,
  ).toBe(401);
  expect((await request("GET", "/api/v1/projects")).status).toBe(200);
  const kept = await request("GET", `/api/v1/projects/${id}`);
  expect(await kept.json()).toMatchObject({ createdBy: doomed.actor.id });
  expect(doomed.actor.id).not.toBe(bot.actor.id);
});

test("a revoked key cannot write: POST project, PATCH issue and POST comment are 401s that change nothing", async () => {
  const retired = addBot("retired-writer");
  const created = (await (
    await request("POST", "/api/v1/projects", {
      json: { key: projectKey(), name: "target" },
    })
  ).json()) as { id: string };
  const filed = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: created.id, title: "target" },
    })
  ).json()) as { id: string };

  const writes = (tag: string) =>
    [
      ["POST", "/api/v1/projects", { key: projectKey(), name: tag }],
      ["PATCH", `/api/v1/issues/${filed.id}`, { title: tag }],
      ["POST", `/api/v1/issues/${filed.id}/comments`, { body: tag }],
    ] as const;
  const send = (tag: string) =>
    Promise.all(
      writes(tag).map(([method, path, json]) =>
        request(method, path, { json, key: retired.key }),
      ),
    );

  // live key first, so the 401s below are the revocation and not a bad request
  for (const res of await send("while live")) {
    expect(res.status).toBeLessThan(300);
  }

  revokeKey(db, retired.key.split("_")[1] as string);
  const tables = () => ({
    projects: db.select().from(project).all(),
    issues: db.select().from(issue).all(),
    comments: db.select().from(comment).all(),
    events: db.select().from(activityEvent).all(),
  });
  const before = tables();
  const publishedBefore = published.length;

  for (const res of await send("after revoke")) {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized);
  }
  expect(tables()).toEqual(before);
  expect(published).toHaveLength(publishedBefore);
});

test("a second key minted for a bot writes as that bot, and revoking it leaves the first working", async () => {
  const twoKeys = addBot("two keys");
  const second = createKey(db, twoKeys.actor.id);
  const res = await request("POST", "/api/v1/projects", {
    key: second.key,
    json: { key: projectKey(), name: "second key" },
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ createdBy: twoKeys.actor.id });

  revokeKey(db, second.key.split("_")[1] as string);
  expect(
    (await request("GET", "/api/v1/projects", { key: second.key })).status,
  ).toBe(401);
  expect(
    (await request("GET", "/api/v1/projects", { key: twoKeys.key })).status,
  ).toBe(200);
});
