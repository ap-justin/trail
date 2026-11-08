import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { app, bot, request } = setupTestApp();

const MiB = 1024 * 1024;

function postProjects(body: string, headers: Record<string, string> = {}) {
  return app.request("/api/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

const oversized = JSON.stringify({ name: "x".repeat(MiB) });

test.each([
  ["streamed", {}],
  ["with a Content-Length", { "content-length": String(oversized.length) }],
])(
  "a body over 1 MiB, %s, is a 413 in the shared shape",
  async (_, headers) => {
    const res = await postProjects(oversized, headers);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "request body exceeds 1048576 bytes",
      },
    });
  },
);

test("an oversized body without a key is still a 401", async () => {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversized,
  });
  expect(res.status).toBe(401);
});

async function created(path: string, json: unknown) {
  const res = await request("POST", path, { json });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const projectId = await created("/api/v1/projects", { name: "limits" });
const issueId = await created("/api/v1/issues", { projectId, title: "t" });
const KiB64 = 64 * 1024;

test.each([
  ["POST", "/api/v1/projects", "name", 200, {}],
  ["POST", "/api/v1/projects", "description", KiB64, { name: "p" }],
  ["PATCH", `/api/v1/projects/${projectId}`, "name", 200, {}],
  ["PATCH", `/api/v1/projects/${projectId}`, "description", KiB64, {}],
  ["POST", "/api/v1/issues", "title", 300, { projectId }],
  ["POST", "/api/v1/issues", "description", KiB64, { projectId, title: "t" }],
  ["PATCH", `/api/v1/issues/${issueId}`, "title", 300, {}],
  ["PATCH", `/api/v1/issues/${issueId}`, "description", KiB64, {}],
  ["POST", `/api/v1/issues/${issueId}/comments`, "body", KiB64, {}],
] as const)(
  "%s %s caps %s at %i characters",
  async (method, path, field, max, rest) => {
    const at = await request(method, path, {
      json: { ...rest, [field]: "x".repeat(max) },
    });
    expect(at.status).toBeLessThan(300);

    const over = await request(method, path, {
      json: { ...rest, [field]: "x".repeat(max + 1) },
    });
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual({
      error: {
        code: "validation_failed",
        message: expect.stringContaining(field),
      },
    });
  },
);
