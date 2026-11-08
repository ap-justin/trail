import { describe, expect, test } from "vitest";
import { createBot, revokeKey } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, app, request } = setupTestApp();

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
