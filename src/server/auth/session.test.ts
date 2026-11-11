import { Hono } from "hono";
import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import type { ViewerEnv } from "./viewer.js";

const { app, auth, bot, owner, request, signIn, viewerOf } = setupTestApp();

const origin = "http://localhost";

test("a session cookie does not authenticate /api/v1 or /mcp", async () => {
  const cookie = await signIn(owner);
  expect(
    (await request("GET", "/api/v1/projects", { key: null, cookie })).status,
  ).toBe(401);
  expect(
    (
      await request("POST", "/mcp", {
        key: null,
        cookie,
        json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })
    ).status,
  ).toBe(401);
});

test("a bearer token never makes a viewer, a bot's key or a session token", async () => {
  const cookie = await signIn(owner);
  const sessionToken = decodeURIComponent(cookie.split("=")[1] ?? "");
  for (const token of [bot.key, sessionToken, sessionToken.split(".")[0]]) {
    expect(
      await auth.resolveViewer(
        new Headers({ authorization: `Bearer ${token}` }),
      ),
    ).toEqual({ kind: "anonymous" });
  }
});

test("the viewer middleware sets c.var.viewer from the cookie alone", async () => {
  const probe = new Hono<ViewerEnv>()
    .use(auth.viewer)
    .get("/", (c) => c.json(c.var.viewer));
  const cookie = await signIn(owner);
  const asOwner = await probe.request("/", {
    headers: { cookie, authorization: `Bearer ${bot.key}` },
  });
  expect(await asOwner.json()).toMatchObject({ kind: "owner", login: owner });
  const asBot = await probe.request("/", {
    headers: { authorization: `Bearer ${bot.key}` },
  });
  expect(await asBot.json()).toEqual({ kind: "anonymous" });
});

test("signing out ends the session and clears its cookie", async () => {
  const cookie = await signIn(owner);
  const res = await app.request("/api/auth/sign-out", {
    method: "POST",
    headers: { cookie, origin },
  });
  expect(res.status).toBe(200);
  expect(res.headers.getSetCookie().join("\n")).toMatch(
    /session_token=;.*Max-Age=0/,
  );
  expect(await viewerOf(cookie)).toEqual({ kind: "anonymous" });
});

test("a person cannot set their own GitHub login through better-auth", async () => {
  const cookie = await signIn("someone");
  const res = await app.request("/api/auth/update-user", {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ githubLogin: owner }),
  });
  expect(res.status).toBe(404);
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "someone",
  });
});
