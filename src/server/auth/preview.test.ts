import { expect, test } from "vitest";
import { sessionCookie, setupTestApp } from "../test-app.js";

// as on Sky: the preview's public host isn't known ahead, so no BETTER_AUTH_URL
const { app, request, owner } = setupTestApp({
  auth: { preview: true, BETTER_AUTH_URL: undefined },
});

const signIn = (origin?: string | null) =>
  request("POST", "/api/preview/sign-in", { key: null, origin });

const meAs = async (cookie: string) =>
  (await request("GET", "/api/web/me", { key: null, cookie })).json();

test("sign-in takes no body and signs in the owner", async () => {
  const res = await signIn();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ redirectTo: "/" });
  const cookie = sessionCookie(res);
  expect(cookie).not.toBe("");
  expect(await meAs(cookie)).toMatchObject({ state: "owner", login: owner });
});

test("a second sign-in works too, with a session of its own", async () => {
  const first = sessionCookie(await signIn());
  const res = await signIn();
  expect(res.status).toBe(200);
  const second = sessionCookie(res);
  expect(second).not.toBe(first);
  expect(await meAs(first)).toMatchObject({ state: "owner" });
  expect(await meAs(second)).toMatchObject({ state: "owner", login: owner });
});

test("me tells an anonymous visitor that preview sign-in is on", async () => {
  const me = await request("GET", "/api/web/me", { key: null });
  expect(await me.json()).toMatchObject({
    state: "anonymous",
    previewSignIn: true,
  });
});

test("another site's Origin is refused", async () => {
  const res = await signIn("https://elsewhere.example.test");
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({
    error: { code: "INVALID_ORIGIN" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
});

// its own app, so these sign-ins leave the limit above alone
const hosts = setupTestApp({
  auth: { preview: true, BETTER_AUTH_URL: undefined },
});
// a browser sends Origin lowercased, whatever case Host has
const withHost = (host: string, origin = `http://${host.toLowerCase()}`) =>
  hosts.app.request(`http://${host}/api/preview/sign-in`, {
    method: "POST",
    headers: { host, origin },
  });

test.each([
  "localhost",
  "localhost:4123",
  "127.0.0.1",
  "127.0.0.1:3000",
  "[::1]",
  "[::1]:3000",
  "LOCALHOST:4123",
  "LocalHost",
])("a loopback Host %j signs in", async (host) => {
  const res = await withHost(host);
  expect(res.status).toBe(200);
  expect(sessionCookie(res)).not.toBe("");
});

test.each([
  "x.example.test",
  "localhost.example.test",
  "x.localhost",
  "127.0.0.2",
  "[::2]",
  "0.0.0.0:3000",
])("any other Host %j gets the 404 an unknown route gets", async (host) => {
  // a wrong Origin too: the Host check comes first, so it can't tell the route exists
  const res = await withHost(host, "https://elsewhere.example.test");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no route POST /api/preview/sign-in" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
});

// Sky's preview proxy: Host rewritten to the loopback upstream, the browser's
// Origin passed through, the public host and https in X-Forwarded-*
const upstream = "http://localhost:4123";
const proxied = (
  path: string,
  { origin, cookie }: { origin: string; cookie?: string },
) =>
  app.request(`${upstream}${path}`, {
    method: "POST",
    headers: {
      host: "localhost:4123",
      origin,
      "x-forwarded-host": "x.example.test",
      "x-forwarded-proto": "https",
      // as the SPA sends every POST; better-auth checks the origin of a JSON one
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: "{}",
  });

test("behind the preview proxy, sign-in sets a Secure session cookie that reads as the owner", async () => {
  const res = await proxied("/api/preview/sign-in", {
    origin: "https://x.example.test",
  });
  expect(res.status).toBe(200);
  const set = res.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="));
  expect(set).toMatch(/; Secure/i);
  expect(set).toMatch(/; HttpOnly/i);
  expect(await meAs(sessionCookie(res))).toMatchObject({
    state: "owner",
    login: owner,
  });
});

test("behind the preview proxy, another site's Origin is still refused", async () => {
  const res = await proxied("/api/preview/sign-in", {
    origin: "https://elsewhere.example.test",
  });
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("behind the preview proxy, better-auth's own routes take the forwarded origin", async () => {
  const cookie = sessionCookie(await signIn());
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
  expect(await meAs(cookie)).toMatchObject({ state: "anonymous" });
});

test("the session-making endpoint is not served over HTTP", async () => {
  const res = await request("POST", "/api/auth/preview-session-for-owner", {
    key: null,
  });
  expect(res.status).toBe(404);
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("two sign-ins at once on a fresh preview both sign in", async () => {
  const fresh = setupTestApp({
    auth: { preview: true, BETTER_AUTH_URL: undefined },
  });
  const both = await Promise.all([
    fresh.request("POST", "/api/preview/sign-in", { key: null }),
    fresh.request("POST", "/api/preview/sign-in", { key: null }),
  ]);
  expect(both.map((r) => r.status)).toEqual([200, 200]);
});

// its own app, so its limit starts empty and leaves the one above alone
const burst = setupTestApp({
  auth: { preview: true, BETTER_AUTH_URL: undefined },
});

test("sign-ins sent all at once still meet the limit of 10 a minute", async () => {
  const responses = await Promise.all(
    Array.from({ length: 15 }, () =>
      burst.request("POST", "/api/preview/sign-in", { key: null }),
    ),
  );
  const statuses = responses.map((r) => r.status);
  expect(statuses.filter((s) => s === 200)).toHaveLength(10);
  expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  const limited = responses.find((r) => r.status === 429);
  expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(limited?.headers.getSetCookie()).toEqual([]);
});
