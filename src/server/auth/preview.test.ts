import { expect, test } from "vitest";
import { sessionCookie, setupTestApp } from "../test-app.js";

const password = "made-up-preview-password-0123";

// as on Sky: the preview's public host isn't known ahead, so no BETTER_AUTH_URL
const { app, request, owner } = setupTestApp({
  auth: { preview: { password }, BETTER_AUTH_URL: undefined },
});

const signIn = (body: unknown, origin?: string | null) =>
  request("POST", "/api/preview/sign-in", { key: null, json: body, origin });

test.each([
  ["a wrong password", { password: "not-the-made-up-password-0123" }],
  ["no password", {}],
  ["a non-string password", { password: 123 }],
])("%s is refused with 401 and no session", async (_, body) => {
  const res = await signIn(body);
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({
    error: { code: "invalid_password" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("the preview password signs in the owner", async () => {
  const res = await signIn({ password });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res);
  expect(cookie).not.toBe("");
  const me = await request("GET", "/api/web/me", { key: null, cookie });
  expect(await me.json()).toMatchObject({ state: "owner", login: owner });
});

test("me tells an anonymous visitor that preview sign-in is on", async () => {
  const me = await request("GET", "/api/web/me", { key: null });
  expect(await me.json()).toMatchObject({
    state: "anonymous",
    previewSignIn: true,
  });
});

test("a body that isn't JSON is refused with 400", async () => {
  const res = await app.request("/api/preview/sign-in", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: "{password",
  });
  expect(res.status).toBe(400);
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("another site's Origin is refused", async () => {
  const res = await signIn({ password }, "https://elsewhere.example.test");
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie()).toEqual([]);
});

// Sky's preview proxy: Host rewritten to the loopback upstream, the browser's
// Origin passed through, the public host and https in X-Forwarded-*
const upstream = "http://localhost:4123";
const proxied = (
  path: string,
  { origin, cookie }: { origin: string; cookie?: string },
  body?: unknown,
) =>
  app.request(`${upstream}${path}`, {
    method: "POST",
    headers: {
      host: "localhost:4123",
      origin,
      "x-forwarded-host": "x.example.test",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

test("behind the preview proxy, sign-in sets a Secure session cookie that reads as the owner", async () => {
  const res = await proxied(
    "/api/preview/sign-in",
    { origin: "https://x.example.test" },
    { password },
  );
  expect(res.status).toBe(200);
  const set = res.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="));
  expect(set).toMatch(/; Secure/i);
  expect(set).toMatch(/; HttpOnly/i);
  const cookie = sessionCookie(res);
  const me = await request("GET", "/api/web/me", { key: null, cookie });
  expect(await me.json()).toMatchObject({ state: "owner", login: owner });
});

test("behind the preview proxy, another site's Origin is still refused", async () => {
  const res = await proxied(
    "/api/preview/sign-in",
    { origin: "https://elsewhere.example.test" },
    { password },
  );
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("behind the preview proxy, better-auth's own routes take the forwarded origin", async () => {
  const cookie = sessionCookie(await signIn({ password }));
  const refused = await proxied("/api/auth/sign-out", {
    origin: "https://elsewhere.example.test",
    cookie,
  });
  expect(refused.status).toBe(403);
  const signedOut = await proxied("/api/auth/sign-out", {
    origin: "https://x.example.test",
    cookie,
  });
  expect(signedOut.status).toBe(200);
  const me = await request("GET", "/api/web/me", { key: null, cookie });
  expect(await me.json()).toMatchObject({ state: "anonymous" });
});

test("the session-making endpoint is not served over HTTP", async () => {
  const res = await request("POST", "/api/auth/preview-session-for-owner", {
    key: null,
    json: { password },
  });
  expect(res.status).toBe(404);
  expect(res.headers.getSetCookie()).toEqual([]);
});

// its own app, so its limit starts empty and leaves the shared one alone
const burst = setupTestApp({
  auth: { preview: { password }, BETTER_AUTH_URL: undefined },
});

test("wrong passwords sent all at once still meet the limit", async () => {
  const statuses = await Promise.all(
    Array.from({ length: 15 }, async () => {
      const res = await burst.request("POST", "/api/preview/sign-in", {
        key: null,
        json: { password: "a-wrong-guess" },
      });
      return res.status;
    }),
  );
  expect(statuses.filter((s) => s === 401)).toHaveLength(10);
  expect(statuses.filter((s) => s === 429)).toHaveLength(5);
});

// last in the file: it fills the one limit every caller shares
test("after 10 wrong passwords in a minute, even the right one waits", async () => {
  for (let i = 0; i < 10; i++) await signIn({ password: "a-wrong-guess" });
  const res = await signIn({ password });
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(res.headers.getSetCookie()).toEqual([]);
});
