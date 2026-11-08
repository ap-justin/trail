import { expect, test, vi } from "vitest";
import { setupTestApp } from "../test-app.js";

const { db, request } = setupTestApp();

test("an unexpected error is a 500 in the shared shape, logged but not leaked", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // a real failure: the database is gone, so the key lookup throws
  db.$client.close();
  const res = await request("GET", "/api/v1/projects");
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({
    error: { code: "internal", message: "internal server error" },
  });
  expect(text).not.toMatch(/database|at \//);
  expect(log).toHaveBeenCalledOnce();
  log.mockRestore();
});
