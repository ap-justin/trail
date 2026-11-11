import { beforeAll, describe, expect, test } from "vitest";
import { projectKey, setupTestApp } from "../test-app.js";

const { app, request, signIn, owner, addMember, addProject } = setupTestApp();

const a = addProject("A");
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
  cookies.owner = await signIn(owner);
  cookies.memberA = await addMember("member-a", [a.id]);
  cookies.memberNone = await addMember("member-none", []);
  cookies.notInvited = await signIn("outsider");
  const invited = await request("POST", "/api/web/people", {
    key: null,
    cookie: cookies.owner,
    json: { username: "deletable", projectKeys: [] },
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
    "GET /projects",
    { method: "GET", path: () => "/projects" },
    members(200, 200, 200),
  ],
  [
    "GET /projects/:key",
    { method: "GET", path: () => `/projects/${a.key}` },
    members(200, 200, 404),
  ],
  [
    "GET /projects/:key/issues",
    { method: "GET", path: () => `/projects/${a.key}/issues` },
    members(200, 200, 404),
  ],
  [
    "GET /projects/:key/status-updates",
    { method: "GET", path: () => `/projects/${a.key}/status-updates` },
    members(200, 200, 404),
  ],
  [
    "GET /issues/:key",
    { method: "GET", path: () => `/issues/${issueKey}` },
    members(200, 200, 404),
  ],
  ["GET /feed", { method: "GET", path: () => "/feed" }, members(200, 200, 200)],
  [
    "GET /feed?project=",
    { method: "GET", path: () => `/feed?project=${a.key}` },
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
    "GET /events?project=",
    { method: "GET", path: () => `/events?project=${a.key}` },
    members(200, 200, 404),
  ],
  [
    "POST /issues",
    {
      method: "POST",
      path: () => "/issues",
      json: () => ({ projectKey: a.key, title: "filed" }),
    },
    members(201, 201, 404),
  ],
  [
    "POST /issues/:key/comments",
    {
      method: "POST",
      path: () => `/issues/${issueKey}/comments`,
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
      json: () => ({ username: `invitee-${++invites}`, projectKeys: [a.key] }),
    },
    members(201, 404, 404),
  ],
  [
    "PUT /people/:username",
    {
      method: "PUT",
      path: () => "/people/member-none",
      json: () => ({ projectKeys: [] }),
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
];

describe.each(matrix)("%s", (_, call, expected) => {
  test.each(Object.keys(expected) as Viewer[])("as %s", async (viewer) => {
    expect(await statusOf(call, viewer)).toBe(expected[viewer]);
  });
});

test.each(["/api/v1/projects", "/mcp"])(
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

// Every route that takes a project or issue key, or a project filter, as a member of A
// only: the same request, before a project K exists and once K exists out of sight.
const keyed: [string, string, (k: string) => unknown][] = [
  ["GET", "/projects/{K}", () => undefined],
  ["GET", "/projects/{K}/issues", () => undefined],
  ["GET", "/projects/{K}/status-updates", () => undefined],
  ["GET", "/issues/{K}-1", () => undefined],
  ["GET", "/feed?project={K}", () => undefined],
  ["GET", "/events?project={K}", () => undefined],
  ["POST", "/issues", (k) => ({ projectKey: k, title: "t" })],
  ["POST", "/issues/{K}-1/comments", () => ({ body: "b" })],
];

test("a project or issue the viewer can't see answers exactly as one that doesn't exist, on every keyed route", async () => {
  const k = projectKey();
  const snapshot = async () =>
    Promise.all(
      keyed.map(async ([method, template, json]) => {
        const res = await request(
          method,
          `/api/web${template.replaceAll("{K}", k)}`,
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
  const created = await request("POST", "/api/v1/projects", {
    json: { key: k, name: "out of sight" },
  });
  expect(created.status).toBe(201);
  const filed = await request("POST", "/api/v1/issues", {
    json: { projectId: k, title: "hidden" },
  });
  expect(filed.status).toBe(201);
  const hidden = await snapshot();

  expect(hidden).toEqual(missing);
  for (const row of missing) expect(row.status, row.route).toBe(404);
});
