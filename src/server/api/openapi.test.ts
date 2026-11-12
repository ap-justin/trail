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
      "GET /bots",
      "GET /issues",
      "GET /issues/{id}",
      "GET /issues/{id}/comments",
      "GET /projects",
      "GET /projects/{id}",
      "GET /projects/{id}/labels",
      "GET /projects/{id}/status-updates",
      "GET /whoami",
      "PATCH /issues/{id}",
      "PATCH /projects/{id}",
      "POST /import",
      "POST /issues",
      "POST /issues/{id}/comments",
      "POST /projects",
      "POST /projects/{id}/labels",
      "POST /projects/{id}/status-updates",
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
  const withConflict = (codes: string[]) => [...codes, "409"].sort();
  expect(statuses).toEqual({
    "GET /activity": withForbidden(withNotFound(list)),
    "GET /bots": withForbidden(list),
    "GET /issues": withForbidden(withNotFound(list)),
    "GET /issues/{id}": withForbidden(withNotFound(list)),
    "GET /issues/{id}/comments": withForbidden(withNotFound(list)),
    "GET /projects": withForbidden(list),
    "GET /projects/{id}": withForbidden(withNotFound(list)),
    "GET /projects/{id}/labels": withForbidden(withNotFound(list)),
    "GET /projects/{id}/status-updates": withForbidden(withNotFound(list)),
    "GET /whoami": ["200", "401"],
    "PATCH /issues/{id}": withForbidden(withNotFound(write("200"))),
    "PATCH /projects/{id}": withForbidden(withNotFound(write("200"))),
    "POST /import": withConflict(withForbidden(write("200"))),
    "POST /issues": withConflict(withForbidden(withNotFound(write("201")))),
    "POST /issues/{id}/comments": withConflict(
      withForbidden(withNotFound(write("201"))),
    ),
    "POST /projects": withConflict(withForbidden(write("201"))),
    "POST /projects/{id}/labels": withConflict(
      withForbidden(withNotFound(write("201"))),
    ),
    "POST /projects/{id}/status-updates": withConflict(
      withForbidden(withNotFound(write("201"))),
    ),
  });
});

test("every create documents the Idempotency-Key header, and no other operation does", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<
      string,
      Record<string, { parameters?: { name: string; in: string }[] }>
    >;
  };
  const withHeader = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, op]) =>
        (op.parameters ?? []).some(
          (p) =>
            p.in === "header" && p.name.toLowerCase() === "idempotency-key",
        ),
      )
      .map(([method]) => `${method.toUpperCase()} ${path}`),
  );
  expect(withHeader.sort()).toEqual(
    [
      "POST /issues",
      "POST /issues/{id}/comments",
      "POST /projects",
      "POST /projects/{id}/labels",
      "POST /projects/{id}/status-updates",
    ].sort(),
  );
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

test("project key fields advertise the key rule as a pattern", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    components: {
      schemas: Record<
        string,
        { properties: Record<string, { pattern?: string }> }
      >;
    };
  };
  for (const schema of ["ProjectCreate", "Import"]) {
    expect(
      spec.components.schemas[schema]?.properties.key?.pattern,
      schema,
    ).toBe("^[A-Za-z0-9]{2,10}$");
  }
});

test("the /activity nextCursor says which parameter takes it back in each mode", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  type Page = {
    properties: { nextCursor: { description?: string } };
  };
  const spec = (await res.json()) as {
    paths: Record<
      string,
      Record<
        string,
        {
          responses: Record<
            string,
            { content: Record<string, { schema: Page }> }
          >;
        }
      >
    >;
  };
  const nextCursor = (path: string) =>
    spec.paths[path]?.get?.responses["200"]?.content["application/json"]?.schema
      .properties.nextCursor.description;

  const activity = nextCursor("/activity");
  expect(activity).toMatch(/after.*pass it back as `after`/);
  expect(activity).toMatch(/pass it back as `cursor`/);
  expect(nextCursor("/issues")).toBe(
    "Pass as `cursor` for the next page; null on the last.",
  );
});

test("an import issue's statusType advertises Linear's seven state types", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    components: {
      schemas: Record<
        string,
        { properties: Record<string, { type?: string; enum?: string[] }> }
      >;
    };
  };
  expect(spec.components.schemas.ImportIssue?.properties.statusType).toEqual(
    expect.objectContaining({
      type: "string",
      enum: [
        "backlog",
        "unstarted",
        "triage",
        "started",
        "completed",
        "canceled",
        "duplicate",
      ],
    }),
  );
});
