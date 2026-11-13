import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { webhookSubscription } from "../db/schema.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { PNG } from "../test-images.js";

const { app, db, bot, addProject } = setupTestApp();
const project = addProject("json-only");

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

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

const refusal = async (res: Response) => {
  expect(res.status).toBe(415);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("unsupported_media_type");
  expect(error.message).toContain("Content-Type: application/json");
  return error.message as string;
};

async function newWebhook() {
  const res = await send("POST", "/webhooks", {
    type: "application/json",
    body: JSON.stringify({
      url: `https://bot.example.com/json-only/${Math.random()}`,
      secret: "whsec_json_only_0123456789abcdef",
      projects: [project.key],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as Body).id as string;
}

test("a form body on a webhook update is a 415 that resumes nothing", async () => {
  const id = await newWebhook();
  db.update(webhookSubscription)
    .set({ pausedAt: new Date(), consecutiveFailures: 5 })
    .where(eq(webhookSubscription.id, id))
    .run();
  const res = await send("PATCH", `/webhooks/${id}`, {
    type: "application/x-www-form-urlencoded",
    body: "projects=A",
  });
  expect(await refusal(res)).toContain("application/x-www-form-urlencoded");
  const row = db
    .select()
    .from(webhookSubscription)
    .where(eq(webhookSubscription.id, id))
    .get();
  expect(row?.pausedAt).not.toBeNull();
  expect(row?.consecutiveFailures).toBe(5);
});

test.each([
  ["a form", "application/x-www-form-urlencoded", "a=b"],
  ["multipart", "multipart/form-data; boundary=x", "--x--"],
  ["plain text", "text/plain", '{"name":"x"}'],
  ["no type at all", undefined, '{"name":"x"}'],
  ["a +json subtype", "application/vnd.api+json", '{"name":"x"}'],
  ["a similar prefix", "application/jsonp", '{"name":"x"}'],
  ["an empty type", "", '{"name":"x"}'],
])("%s is refused on every kind of write", async (_, type, body) => {
  const id = await newWebhook();
  for (const [method, path] of [
    ["POST", "/projects"],
    ["PATCH", `/projects/${project.key}`],
    ["POST", "/issues"],
    ["POST", `/webhooks`],
    ["PATCH", `/webhooks/${id}`],
    ["PUT", `/webhooks/${id}/secret`],
    ["POST", "/import"],
  ] as const) {
    const res = await send(method, path, { type, body });
    expect(res.status, `${method} ${path}`).toBe(415);
  }
});

test.each([
  "application/json",
  "application/json; charset=utf-8",
  "application/json;charset=UTF-8",
  "Application/JSON",
  " application/json ",
])("%s is accepted", async (type) => {
  const res = await send("POST", "/projects", {
    type,
    body: JSON.stringify({ key: projectKey(), name: "accepted" }),
  });
  expect(res.status).toBe(201);
});

test("a write with no body still works whatever its Content-Type, and reads and deletes are untouched", async () => {
  const id = await newWebhook();
  expect((await send("POST", `/webhooks/${id}/ping`, {})).status).toBe(200);
  expect((await send("GET", `/webhooks/${id}`, {})).status).toBe(200);
  expect((await send("DELETE", `/webhooks/${id}`, {})).status).toBe(200);
  // with nothing to read, the type is not looked at; a body of the same type is refused
  const other = await newWebhook();
  for (const type of ["application/x-www-form-urlencoded", "text/plain", ""]) {
    expect(
      (await send("POST", `/webhooks/${other}/ping`, { type })).status,
      type,
    ).toBe(200);
  }
  const empty = await send("POST", `/webhooks/${other}/ping`, {
    type: "text/plain",
    body: "",
  });
  expect(empty.status).toBe(200);
  const withBody = await send("POST", `/webhooks/${other}/ping`, {
    type: "application/x-www-form-urlencoded",
    body: "a=b",
  });
  expect(withBody.status).toBe(415);
});

test("the photo upload keeps taking raw bytes, of any type", async () => {
  for (const type of ["image/png", "application/octet-stream", undefined]) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bot.key}`,
    };
    if (type !== undefined) headers["content-type"] = type;
    const res = await app.request("/api/v1/me/photo", {
      method: "PUT",
      headers,
      body: PNG,
    });
    expect(res.status, String(type)).toBe(200);
  }
});

test("an unauthenticated write is a 401 before its type is looked at", async () => {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "x",
  });
  expect(res.status).toBe(401);
});

test("MCP takes its own request types as before", async () => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    }),
  });
  expect(res.status).toBe(200);
});
