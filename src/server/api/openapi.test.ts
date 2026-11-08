import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { app, bot, request } = setupTestApp();

test("GET /api/v1/openapi.json serves the spec without a key", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  expect(res.status).toBe(200);
  const spec = (await res.json()) as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
    security: unknown;
    components: { securitySchemes: unknown };
  };

  expect(spec.openapi).toMatch(/^3\.1\./);
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );
  expect(operations.sort()).toEqual(
    [
      "GET /activity",
      "GET /issues",
      "GET /issues/{id}",
      "GET /issues/{id}/comments",
      "GET /projects",
      "GET /projects/{id}",
      "PATCH /issues/{id}",
      "PATCH /projects/{id}",
      "POST /issues",
      "POST /issues/{id}/comments",
      "POST /projects",
    ].sort(),
  );
  expect(spec.components.securitySchemes).toEqual({
    bearer: expect.objectContaining({ type: "http", scheme: "bearer" }),
  });
  expect(spec.security).toEqual([{ bearer: [] }]);
});

test("the spec lists the error statuses each operation can return", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<string, Record<string, { responses: object }>>;
  };
  const statuses = Object.fromEntries(
    Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => [
        `${method.toUpperCase()} ${path}`,
        Object.keys(op.responses).sort(),
      ]),
    ),
  );

  const list = ["200", "401", "422"];
  const write = (ok: string) => [ok, "400", "401", "413", "415", "422"].sort();
  const withNotFound = (codes: string[]) => [...codes, "404"].sort();
  const withForbidden = (codes: string[]) => [...codes, "403"].sort();
  expect(statuses).toEqual({
    "GET /activity": list,
    "GET /issues": list,
    "GET /issues/{id}": withNotFound(list),
    "GET /issues/{id}/comments": withNotFound(list),
    "GET /projects": list,
    "GET /projects/{id}": withNotFound(list),
    "PATCH /issues/{id}": withForbidden(withNotFound(write("200"))),
    "PATCH /projects/{id}": withForbidden(withNotFound(write("200"))),
    "POST /issues": withNotFound(write("201")),
    "POST /issues/{id}/comments": withNotFound(write("201")),
    "POST /projects": withForbidden(write("201")),
  });
});

test.each([
  ["no Content-Type", {}, '{"name":"p"}', 415],
  ["malformed JSON", { "content-type": "application/json" }, "{", 400],
  ["no body", { "content-type": "application/json" }, undefined, 400],
])("a body route answers %s with a %i", async (_, headers, body, status) => {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${bot.key}`, ...headers },
    body,
  });
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({
    error: { code: expect.any(String), message: expect.any(String) },
  });
});
