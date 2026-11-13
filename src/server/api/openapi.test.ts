import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { PNG } from "../test-images.js";

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
      "GET /photos/{actorId}/{hash}",
      "DELETE /me/photo",
      "PUT /me/photo",
      "PATCH /issues/{id}",
      "PATCH /projects/{id}",
      "POST /import",
      "POST /issues",
      "POST /issues/{id}/comments",
      "POST /projects",
      "POST /projects/{id}/labels",
      "POST /projects/{id}/status-updates",
      "GET /webhooks",
      "POST /webhooks",
      "GET /webhooks/{id}",
      "PATCH /webhooks/{id}",
      "DELETE /webhooks/{id}",
      "PUT /webhooks/{id}/secret",
      "POST /webhooks/{id}/ping",
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
    "GET /photos/{actorId}/{hash}": ["200", "401", "404"],
    "DELETE /me/photo": ["200", "401"],
    "PUT /me/photo": ["200", "401", "413", "422"],
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
    "GET /webhooks": withForbidden(list),
    "POST /webhooks": withConflict(withForbidden(withNotFound(write("201")))),
    "GET /webhooks/{id}": withForbidden(withNotFound(list)),
    "PATCH /webhooks/{id}": withConflict(
      withForbidden(withNotFound(write("200"))),
    ),
    "DELETE /webhooks/{id}": withForbidden(withNotFound(list)),
    "PUT /webhooks/{id}/secret": withForbidden(withNotFound(write("200"))),
    "POST /webhooks/{id}/ping": [
      ...withForbidden(withNotFound(list)),
      "415",
      "429",
    ].sort(),
  });
});

test("the ping's 429 declares the Retry-After header the route always sets", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<
      string,
      Record<
        string,
        { responses: Record<string, { headers?: Record<string, unknown> }> }
      >
    >;
  };
  expect(
    spec.paths["/webhooks/{id}/ping"]?.post?.responses["429"]?.headers,
  ).toEqual({
    "Retry-After": {
      description: expect.any(String),
      required: true,
      schema: { type: "integer", minimum: 1 },
    },
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

test("PUT /me/photo takes a body of any media type as raw bytes, in 3.1 form", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<string, Record<string, { requestBody: { content: object } }>>;
  };
  const content = spec.paths["/me/photo"]?.put?.requestBody.content as Record<
    string,
    unknown
  >;
  expect(content).toEqual({
    "image/png": {},
    "image/jpeg": {},
    "image/webp": {},
    "*/*": {},
  });
});

test("setting a photo answers a URL that is never null; removing one answers null", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  type Schema = {
    $ref?: string;
    type?: string | string[];
    properties?: Record<string, Schema>;
    required?: string[];
  };
  type Operation = {
    responses: Record<
      string,
      { content: { "application/json": { schema: Schema } } }
    >;
  };
  const spec = (await res.json()) as {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
  };
  const okBody = (method: string) => {
    const schema =
      spec.paths["/me/photo"]?.[method]?.responses["200"]?.content[
        "application/json"
      ].schema;
    const name = schema?.$ref?.split("/").at(-1) ?? "";
    return spec.components.schemas[name] ?? schema;
  };

  const set = okBody("put");
  expect(set?.properties?.photoUrl?.type).toBe("string");
  expect(set?.required).toEqual(["photoUrl"]);
  const cleared = okBody("delete");
  expect(cleared?.properties?.photoUrl?.type).toBe("null");
  expect(cleared?.required).toEqual(["photoUrl"]);
});

test("the photo route is documented under its own /api server, and the documented URL serves the image", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  type Operation = {
    servers?: { url: string }[];
    security?: unknown;
    parameters?: { name: string; in: string; required?: boolean }[];
    responses: Record<string, { content?: Record<string, unknown> }>;
  };
  const spec = (await res.json()) as {
    servers: { url: string }[];
    paths: Record<string, Record<string, Operation>>;
  };
  const path = "/photos/{actorId}/{hash}";
  const op = spec.paths[path]?.get;
  expect(op?.servers).toEqual([{ url: "/api" }]);
  expect(op?.security).toBeUndefined();
  expect(op?.parameters?.map((p) => [p.in, p.name, p.required]).sort()).toEqual(
    [
      ["path", "actorId", true],
      ["path", "hash", true],
    ],
  );
  expect(Object.keys(op?.responses["200"]?.content ?? {}).sort()).toEqual([
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  expect(Object.keys(op?.responses["404"]?.content ?? {})).toEqual([
    "application/json",
  ]);

  const put = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "image/png",
    },
    body: PNG,
  });
  const { photoUrl } = (await put.json()) as { photoUrl: string };
  const [, , , actorId, hash] = photoUrl.split("/");
  const documented = `${op?.servers?.[0]?.url}${path}`
    .replace("{actorId}", actorId ?? "")
    .replace("{hash}", hash ?? "");
  expect(documented).toBe(photoUrl);
  const served = await request("GET", documented);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
});
