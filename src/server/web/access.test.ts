import { beforeAll, describe, expect, test } from "vitest";
import { message } from "../db/schema.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { app, db, request, signIn, owner, addMember, addProject, addBot, bot } =
  setupTestApp();

const a = addProject("A");
const other = addBot("other").actor;
let issueKey = "";
const cookies: Record<Viewer, string | undefined> = {
  owner: undefined,
  memberA: undefined,
  memberNone: undefined,
  notInvited: undefined,
  anonymous: undefined,
};
type Viewer = "owner" | "memberA" | "memberNone" | "notInvited" | "anonymous";

let invites = 0;

beforeAll(async () => {
  const res = await request("POST", "/api/v1/issues", {
    json: { projectId: a.id, title: "target" },
  });
  issueKey = ((await res.json()) as { key: string }).key;
  const made = await request("POST", "/api/v1/projects", {
    json: { name: "Seen", slug: "seen", products: [a.key] },
  });
  expect(made.status).toBe(201);
  cookies.owner = await signIn(owner);
  cookies.memberA = await addMember("member-a", [a.id]);
  cookies.memberNone = await addMember("member-none", []);
  cookies.notInvited = await signIn("outsider");
  const invited = await request("POST", "/api/web/people", {
    key: null,
    cookie: cookies.owner,
    json: { username: "deletable", products: [] },
  });
  expect(invited.status).toBe(201);
});

type Call = { method: string; path: () => string; json?: () => unknown };

/** Sends `call` as `viewer` and returns the status, closing a stream it opened. */
async function statusOf(call: Call, viewer: Viewer) {
  const res = await request(call.method, `/api/web${call.path()}`, {
    key: null,
    cookie: cookies[viewer],
    json: call.json?.(),
  });
  await res.body?.cancel();
  return res.status;
}

const everyone = (status: number) => ({
  owner: status,
  memberA: status,
  memberNone: status,
  notInvited: status,
  anonymous: status,
});
const members = (owner: number, memberA: number, memberNone: number) => ({
  owner,
  memberA,
  memberNone,
  notInvited: 403,
  anonymous: 401,
});

// one row per route: the status each viewer gets
const matrix: [string, Call, Record<Viewer, number>][] = [
  ["GET /me", { method: "GET", path: () => "/me" }, everyone(200)],
  [
    "GET /products",
    { method: "GET", path: () => "/products" },
    members(200, 200, 200),
  ],
  [
    "GET /products/:key",
    { method: "GET", path: () => `/products/${a.key}` },
    members(200, 200, 404),
  ],
  [
    "GET /products/:key/items",
    { method: "GET", path: () => `/products/${a.key}/items` },
    members(200, 200, 404),
  ],
  [
    "GET /products/:key/status-updates",
    { method: "GET", path: () => `/products/${a.key}/status-updates` },
    members(200, 200, 404),
  ],
  [
    "GET /projects",
    { method: "GET", path: () => "/projects" },
    members(200, 200, 200),
  ],
  [
    "GET /projects/:slug",
    { method: "GET", path: () => "/projects/seen" },
    members(200, 200, 404),
  ],
  [
    "GET /projects/:slug/items",
    { method: "GET", path: () => "/projects/seen/items" },
    members(200, 200, 404),
  ],
  [
    "GET /projects/:slug/status-updates",
    { method: "GET", path: () => "/projects/seen/status-updates" },
    members(200, 200, 404),
  ],
  [
    "GET /items/:key",
    { method: "GET", path: () => `/items/${issueKey}` },
    members(200, 200, 404),
  ],
  ["GET /feed", { method: "GET", path: () => "/feed" }, members(200, 200, 200)],
  [
    "GET /feed?product=",
    { method: "GET", path: () => `/feed?product=${a.key}` },
    members(200, 200, 404),
  ],
  [
    "GET /feed?project=",
    { method: "GET", path: () => "/feed?project=seen" },
    members(200, 200, 404),
  ],
  [
    "GET /search",
    { method: "GET", path: () => "/search?q=target" },
    members(200, 200, 200),
  ],
  [
    "GET /events",
    { method: "GET", path: () => "/events" },
    members(200, 200, 200),
  ],
  [
    "GET /events?product=",
    { method: "GET", path: () => `/events?product=${a.key}` },
    members(200, 200, 404),
  ],
  [
    "GET /events?project=",
    { method: "GET", path: () => "/events?project=seen" },
    members(200, 200, 404),
  ],
  [
    "POST /issues",
    {
      method: "POST",
      path: () => "/issues",
      json: () => ({ product: a.key, title: "filed" }),
    },
    members(201, 201, 404),
  ],
  [
    "POST /items/:key/comments",
    {
      method: "POST",
      path: () => `/items/${issueKey}/comments`,
      json: () => ({ body: "hi" }),
    },
    members(201, 201, 404),
  ],
  [
    "GET /people",
    { method: "GET", path: () => "/people" },
    members(200, 404, 404),
  ],
  [
    "POST /people",
    {
      method: "POST",
      path: () => "/people",
      json: () => ({ username: `invitee-${++invites}`, products: [a.key] }),
    },
    members(201, 404, 404),
  ],
  [
    "PUT /people/:username",
    {
      method: "PUT",
      path: () => "/people/member-none",
      json: () => ({ products: [] }),
    },
    members(200, 404, 404),
  ],
  [
    "DELETE /people/:username",
    {
      method: "DELETE",
      path: () => "/people/deletable",
    },
    members(204, 404, 404),
  ],
  [
    "GET /messages",
    { method: "GET", path: () => "/messages" },
    members(200, 404, 404),
  ],
  [
    "GET /messages/:a/:b",
    { method: "GET", path: () => `/messages/${bot.actor.id}/${other.id}` },
    members(200, 404, 404),
  ],
];

describe.each(matrix)("%s", (_, call, expected) => {
  test.each(Object.keys(expected) as Viewer[])("as %s", async (viewer) => {
    expect(await statusOf(call, viewer)).toBe(expected[viewer]);
  });
});

test.each(["/api/v1/products", "/mcp"])(
  "a session cookie without a bot key is a 401 on %s",
  async (path) => {
    const res = await app.request(path, {
      method: path === "/mcp" ? "POST" : "GET",
      headers: {
        cookie: cookies.owner as string,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: path === "/mcp" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
  },
);

// the bot-key column of the matrix: a key with no session cookie is no viewer, so every route that
// refuses an anonymous viewer refuses it too, and /me, which answers anyone, sees nobody signed in
test.each(matrix.filter(([, , expected]) => expected.anonymous === 401))(
  "a bot key without a session cookie is a 401 on %s",
  async (_, call) => {
    const res = await request(call.method, `/api/web${call.path()}`, {
      key: bot.key,
      json: call.json?.(),
    });
    await res.body?.cancel();
    expect(res.status).toBe(401);
  },
);

test("a bot key without a session cookie is no one on /me", async () => {
  const res = await request("GET", "/api/web/me", { key: bot.key });
  expect(((await res.json()) as { state: string }).state).toBe("anonymous");
});

test.each(["owner", "memberA"] as const)(
  "a person's session cookie, as %s, can't send a message through POST /api/v1/messages",
  async (viewer) => {
    const before = db.select().from(message).all().length;
    const res = await request("POST", "/api/v1/messages", {
      key: null,
      cookie: cookies[viewer],
      json: { to: other.id, text: "from a person" },
    });
    expect(res.status).toBe(401);
    expect(db.select().from(message).all()).toHaveLength(before);
  },
);

// Every route that takes a product or item key, a project slug, or a filter by
// either, as a member of A only: the same request, before a product K and a
// project S exist and once both exist out of sight (S draws only from K).
const keyed: [string, string, (k: string) => unknown][] = [
  ["GET", "/products/{K}", () => undefined],
  ["GET", "/products/{K}/items", () => undefined],
  ["GET", "/products/{K}/status-updates", () => undefined],
  ["GET", "/items/{K}-1", () => undefined],
  ["GET", "/feed?product={K}", () => undefined],
  ["GET", "/events?product={K}", () => undefined],
  ["POST", "/issues", (k) => ({ product: k, title: "t" })],
  ["POST", "/items/{K}-1/comments", () => ({ body: "b" })],
  ["GET", "/projects/{S}", () => undefined],
  ["GET", "/projects/{S}/items", () => undefined],
  ["GET", "/projects/{S}/status-updates", () => undefined],
  ["GET", "/feed?project={S}", () => undefined],
  ["GET", "/events?project={S}", () => undefined],
];

test("a product, item or project the viewer can't see answers exactly as one that doesn't exist, on every keyed route", async () => {
  const k = projectKey();
  const slug = `hidden-${k.toLowerCase()}`;
  const snapshot = async () =>
    Promise.all(
      keyed.map(async ([method, template, json]) => {
        const res = await request(
          method,
          `/api/web${template.replaceAll("{K}", k).replaceAll("{S}", slug)}`,
          { key: null, cookie: cookies.memberA, json: json(k) },
        );
        return {
          route: `${method} ${template}`,
          status: res.status,
          headers: [...res.headers].filter(([name]) => name !== "set-cookie"),
          body: await res.text(),
        };
      }),
    );
  const missing = await snapshot();
  const created = await request("POST", "/api/v1/products", {
    json: { key: k, name: "out of sight" },
  });
  expect(created.status).toBe(201);
  const filed = await request("POST", "/api/v1/items", {
    json: { type: "issue", product: k, title: "hidden" },
  });
  expect(filed.status).toBe(201);
  const grouped = await request("POST", "/api/v1/projects", {
    json: { name: "Hidden", slug, products: [k] },
  });
  expect(grouped.status).toBe(201);
  const hidden = await snapshot();

  expect(hidden).toEqual(missing);
  for (const row of missing) expect(row.status, row.route).toBe(404);
});
