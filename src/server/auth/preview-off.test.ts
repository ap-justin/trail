import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { request, auth } = setupTestApp();

test("without preview mode there is no test sign-in route", async () => {
  const res = await request("POST", "/api/preview/sign-in", { key: null });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no route POST /api/preview/sign-in" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(auth.previewSignIn).toBe(null);
});

test("without preview mode, me tells the sign-in page there is no preview sign-in", async () => {
  const me = await request("GET", "/api/web/me", { key: null });
  expect(await me.json()).toMatchObject({
    state: "anonymous",
    previewSignIn: false,
  });
});
