import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { user } from "../db/schema.js";
import { sessionCookie, setupTestApp, testAuthConfig } from "../test-app.js";
import { createAuth } from "./auth.js";
import { PREVIEW_PERSON } from "./preview.js";

// Every group builds its own app: the sign-in limiter (10 a minute, one window
// for every caller) is per app, so no test's outcome depends on how many
// sign-ins another test, or another row, has spent.
// as on Sky: the preview's public host isn't known ahead, so no BETTER_AUTH_URL
function previewApp() {
  const t = setupTestApp({
    auth: { preview: true, BETTER_AUTH_URL: undefined },
  });
  return {
    ...t,
    signIn: (origin?: string | null) =>
      t.request("POST", "/api/preview/sign-in", { key: null, origin }),
    meAs: async (cookie: string) =>
      (await t.request("GET", "/api/web/me", { key: null, cookie })).json(),
    previewUsers: () =>
      t.db
        .select()
        .from(user)
        .where(eq(user.email, PREVIEW_PERSON.email))
        .all(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const main = previewApp();

test("sign-in takes no body and signs in the owner", async () => {
  const res = await main.signIn();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ redirectTo: "/" });
  const cookie = sessionCookie(res);
  expect(cookie).not.toBe("");
  expect(await main.meAs(cookie)).toMatchObject({
    state: "owner",
    login: main.owner,
  });
});

test("a second sign-in works too, with a session of its own", async () => {
  const first = sessionCookie(await main.signIn());
  const res = await main.signIn();
  expect(res.status).toBe(200);
  const second = sessionCookie(res);
  expect(second).not.toBe(first);
  expect(await main.meAs(first)).toMatchObject({ state: "owner" });
  expect(await main.meAs(second)).toMatchObject({
    state: "owner",
    login: main.owner,
  });
});

test("me tells an anonymous visitor that preview sign-in is on", async () => {
  const me = await main.request("GET", "/api/web/me", { key: null });
  expect(await me.json()).toMatchObject({
    state: "anonymous",
    previewSignIn: true,
  });
});

const meWithHost = async (host: string) =>
  (
    await main.app.request(`http://${host}/api/web/me`, { headers: { host } })
  ).json();

test.each(["localhost:4123", "[::1]"])(
  "me offers preview sign-in under the loopback Host %j",
  async (host) => {
    expect(await meWithHost(host)).toMatchObject({ previewSignIn: true });
  },
);

// the route 404s under any other Host, so a button there could only fail
test.each(["x.example.test", "127.0.0.2"])(
  "me offers no preview sign-in under the Host %j",
  async (host) => {
    expect(await meWithHost(host)).toMatchObject({ previewSignIn: false });
  },
);

test("another site's Origin is refused", async () => {
  const res = await main.signIn("https://elsewhere.example.test");
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({
    error: { code: "INVALID_ORIGIN" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("the session-making endpoint is not served over HTTP", async () => {
  const res = await main.request(
    "POST",
    "/api/auth/preview-session-for-owner",
    {
      key: null,
    },
  );
  expect(res.status).toBe(404);
  expect(res.headers.getSetCookie()).toEqual([]);
});

// a browser sends Origin lowercased, whatever case Host has
const withHost = (
  t: ReturnType<typeof previewApp>,
  host: string,
  origin = `http://${host.toLowerCase()}`,
) =>
  t.app.request(`http://${host}/api/preview/sign-in`, {
    method: "POST",
    headers: { host, origin },
  });

// an app per row: a row's sign-in spends nothing another row needs
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
  const res = await withHost(previewApp(), host);
  expect(res.status).toBe(200);
  expect(sessionCookie(res)).not.toBe("");
});

const refused = previewApp();
test.each([
  "x.example.test",
  "localhost.example.test",
  "x.localhost",
  "127.0.0.2",
  "[::2]",
  "0.0.0.0:3000",
])("any other Host %j gets the 404 an unknown route gets", async (host) => {
  // a wrong Origin too: the Host check comes first, so it can't tell the route exists
  const res = await withHost(refused, host, "https://elsewhere.example.test");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no route POST /api/preview/sign-in" },
  });
  expect(res.headers.getSetCookie()).toEqual([]);
});

// Sky's preview proxy: Host rewritten to the loopback upstream, the browser's
// Origin passed through, the public host and https in X-Forwarded-*
const behindProxy = previewApp();
const proxied = (
  path: string,
  { origin, cookie }: { origin: string; cookie?: string },
) =>
  behindProxy.app.request(`http://localhost:4123${path}`, {
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
  expect(await behindProxy.meAs(sessionCookie(res))).toMatchObject({
    state: "owner",
    login: behindProxy.owner,
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
  const cookie = sessionCookie(await behindProxy.signIn());
  const wrongSite = await proxied("/api/auth/sign-out", {
    origin: "https://elsewhere.example.test",
    cookie,
  });
  expect(wrongSite.status).toBe(403);
  const signedOut = await proxied("/api/auth/sign-out", {
    origin: "https://x.example.test",
    cookie,
  });
  expect(signedOut.status).toBe(200);
  expect(await behindProxy.meAs(cookie)).toMatchObject({ state: "anonymous" });
});

test("two sign-ins at once on a fresh preview both sign in as one user row, via the create-user fallback", async () => {
  const t = previewApp();
  // the adapter inserts through this db: count the attempts to insert the preview person
  const insert = vi.spyOn(t.db, "insert");
  const both = await Promise.all([t.signIn(), t.signIn()]);
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  // both found no row, both tried to create it: the second hit the unique email and fell back
  const userInserts = insert.mock.calls.filter(([table]) => table === user);
  expect(userInserts).toHaveLength(2);
  expect(t.previewUsers()).toHaveLength(1);
  for (const res of both) {
    expect(await t.meAs(sessionCookie(res))).toMatchObject({
      state: "owner",
      login: t.owner,
    });
  }
});

test("signing in under a new TRAIL_OWNER_GITHUB moves the preview person's login to it and makes no second user", async () => {
  const t = previewApp();
  expect((await t.signIn()).status).toBe(200);
  expect(t.previewUsers().map((u) => u.githubLogin)).toEqual([t.owner]);
  // a redeploy on the same database, naming another owner
  const redeployed = createAuth({
    db: t.db,
    config: {
      ...testAuthConfig,
      TRAIL_OWNER_GITHUB: "new-owner",
      BETTER_AUTH_URL: undefined,
      preview: true,
    },
  });
  const res = await redeployed.previewSignIn?.(
    new Request("http://localhost/api/preview/sign-in", {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost" },
    }),
  );
  expect(res?.status).toBe(200);
  expect(t.previewUsers().map((u) => u.githubLogin)).toEqual(["new-owner"]);
});

test("a sign-in whose user row can't be made, with none there to fall back on, fails with the app's 500", async () => {
  const t = previewApp();
  const insert = t.db.insert.bind(t.db);
  vi.spyOn(t.db, "insert").mockImplementation(((table: unknown) => {
    if (table === user) throw new Error("disk full");
    return insert(table as never);
  }) as never);
  const res = await t.signIn();
  expect(res.status).toBe(500);
  expect(await res.json()).toMatchObject({ error: { code: "internal" } });
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(t.previewUsers()).toEqual([]);
});

const noOrigin = previewApp();
test.each([
  ["no Origin", null],
  ["another site's Origin", "https://elsewhere.example.test"],
])(
  "%s is refused 403 and takes no slot from the limit",
  async (_name, origin) => {
    // more refusals than the limit of 10: if each took a slot, the sign-in below would be 429
    for (let i = 0; i < 12; i++) {
      const res = await noOrigin.signIn(origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "INVALID_ORIGIN" },
      });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect((await noOrigin.signIn()).status).toBe(200);
  },
);

const burst = previewApp();
test("sign-ins sent all at once still meet the limit of 10 a minute", async () => {
  const responses = await Promise.all(
    Array.from({ length: 15 }, () => burst.signIn()),
  );
  const statuses = responses.map((r) => r.status);
  expect(statuses.filter((s) => s === 200)).toHaveLength(10);
  expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  const limited = responses.find((r) => r.status === 429);
  expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(limited?.headers.getSetCookie()).toEqual([]);
});

test("the limit is one window for every caller: a differently-headed 11th is refused too", async () => {
  const t = previewApp();
  const from = (headers: Record<string, string>) =>
    t.app.request("http://localhost:4123/api/preview/sign-in", {
      method: "POST",
      headers: {
        host: "localhost:4123",
        origin: "http://localhost:4123",
        ...headers,
      },
    });
  for (let i = 0; i < 10; i++) {
    const res = await from({ "x-forwarded-for": `203.0.113.${i}` });
    expect(res.status).toBe(200);
  }
  const others: Record<string, string>[] = [
    { "x-forwarded-for": "198.51.100.99" },
    { "fly-client-ip": "192.0.2.7", "user-agent": "another-browser" },
    {},
  ];
  for (const headers of others) {
    const res = await from(headers);
    expect(res.status).toBe(429);
    expect(res.headers.getSetCookie()).toEqual([]);
  }
});
