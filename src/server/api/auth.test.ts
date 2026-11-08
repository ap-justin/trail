import { describe, expect, test } from "vitest";
import { createBot, revokeKey } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, app, bot, addBot, request } = setupTestApp();

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
    json: { name: "outlives its key" },
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
