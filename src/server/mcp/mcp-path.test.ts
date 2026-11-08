import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { app, bot } = setupTestApp();

const initialize = (path: string, headers: Record<string, string>) =>
  app.request(`http://trail.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    }),
  });

const withKey = { authorization: `Bearer ${bot.key}` };

test("an initialize POST to /mcp/ gets the same reply as /mcp", async () => {
  const bare = await initialize("/mcp", withKey);
  const slashed = await initialize("/mcp/", withKey);
  expect(bare.status).toBe(200);
  expect(slashed.status).toBe(200);
  expect(await slashed.json()).toEqual(await bare.json());
});

test("/mcp/ without a key is a 401", async () => {
  const res = await initialize("/mcp/", {});
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");
});

test("GET /mcp/ is the same 405 as GET /mcp", async () => {
  const res = await app.request("http://trail.test/mcp/", { headers: withKey });
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});

test("another path with a trailing slash still 404s", async () => {
  expect((await app.request("http://trail.test/health")).status).toBe(200);
  expect((await app.request("http://trail.test/health/")).status).toBe(404);
});
