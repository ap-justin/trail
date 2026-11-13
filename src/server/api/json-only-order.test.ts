import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { app, bot, addProject } = setupTestApp();
const project = addProject("json-only-order");

function send(
  method: string,
  path: string,
  { type, body, key = bot.key }: { type?: string; body?: string; key?: string },
) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (type !== undefined) headers["content-type"] = type;
  // a string body would get a text/plain type of its own, and a real connection carries its length
  if (body !== undefined) headers["content-length"] = String(body.length);
  return app.request(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : new TextEncoder().encode(body),
  });
}

const bodies = [
  ["a form", "application/x-www-form-urlencoded", "a=b"],
  ["plain text", "text/plain", '{"name":"x"}'],
  ["no type at all", undefined, '{"name":"x"}'],
  ["JSON", "application/json", '{"name":"x"}'],
] as const;

test.each(bodies)(
  "an unknown path is a 404 in the error shape, whatever the body (%s)",
  async (_, type, body) => {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const res = await send(method, "/no-such-route", { type, body });
      expect(res.status, method).toBe(404);
      expect(await res.json()).toEqual({
        error: {
          code: "not_found",
          message: `no route ${method} /api/v1/no-such-route`,
        },
      });
    }
  },
);

// Hono routes by method and path together, so a known path under another method
// is as unmatched as an unknown path: a 404, not a 405
test.each(bodies)(
  "a write method a known path doesn't take is a 404, whatever the body (%s)",
  async (_, type, body) => {
    for (const [method, path] of [
      ["PUT", "/projects"],
      ["PATCH", "/issues"],
      ["POST", `/projects/${project.key}`],
      ["PUT", "/me"],
    ] as const) {
      const res = await send(method, path, { type, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({
        error: {
          code: "not_found",
          message: `no route ${method} /api/v1${path}`,
        },
      });
    }
  },
);

test("a matched write with a non-JSON body is still a 415", async () => {
  const res = await send("POST", "/projects", {
    type: "text/plain",
    body: '{"name":"x"}',
  });
  expect(res.status).toBe(415);
});

test("an unauthenticated write to an unknown path is a 401 before routing is looked at", async () => {
  const res = await app.request("/api/v1/no-such-route", {
    method: "POST",
    headers: { "content-type": "text/plain", "content-length": "1" },
    body: "x",
  });
  expect(res.status).toBe(401);
});
