import { expect, test } from "vitest";
import { setupTestApp } from "./test-app.js";

const { request } = setupTestApp();

test("GET /health returns ok without a key", async () => {
  const res = await request("GET", "/health", { key: null });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("an unknown route outside the API is a 404 in the shared error shape", async () => {
  const res = await request("GET", "/nope", { key: null });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no route GET /nope" },
  });
});
