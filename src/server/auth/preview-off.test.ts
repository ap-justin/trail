import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { request, auth } = setupTestApp();

test("without preview mode there is no test sign-in route", async () => {
  const res = await request("POST", "/api/preview/sign-in", {
    key: null,
    json: { password: "made-up-preview-password-24" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no route POST /api/preview/sign-in" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(auth.previewSignIn).toBe(null);
});
