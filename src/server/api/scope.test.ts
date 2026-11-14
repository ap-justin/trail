import { beforeAll, expect, test } from "vitest";
import { activityEvent } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, bot, request, addProject } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const a = addProject("A");
const scoped = createBot(db, "bg-ivy", {
  scope: { projects: [a.key], actions: ["read", "issues", "comments"] },
});
let issueA = "";

beforeAll(async () => {
  const res = await request("POST", "/api/v1/issues", {
    json: { projectId: a.key, title: "in A" },
  });
  issueA = ((await res.json()) as Body).key;
});

/** An unscoped write that must succeed, as the test app's own bot. */
async function seed(method: string, path: string, json: unknown) {
  const res = await request(method, path, { json });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return (await res.json()) as Body;
}

/** A project out of the scoped key's reach, with an issue, a comment, a label and a status update. */
async function hiddenProject(key = projectKey()) {
  const created = await seed("POST", "/api/v1/projects", { key, name: "B" });
  const filed = await seed("POST", "/api/v1/issues", {
    projectId: key,
    title: "in B",
  });
  await seed("POST", `/api/v1/issues/${filed.key}/comments`, { body: "b" });
  await seed("POST", `/api/v1/projects/${key}/labels`, { name: "bug" });
  await seed("POST", `/api/v1/projects/${key}/status-updates`, {
    body: "fine",
    health: "on_track",
  });
  return { project: created, issue: filed };
}

// Every route that takes a project or issue reference: the same request,
// before project K exists and once it exists outside the key's projects.
const keyed: [string, string, (k: string) => unknown][] = [
  ["GET", "/projects/{K}", () => undefined],
  ["PATCH", "/projects/{K}", () => ({ name: "renamed" })],
  ["GET", "/projects/{K}/labels", () => undefined],
  ["POST", "/projects/{K}/labels", () => ({ name: "new" })],
  ["GET", "/projects/{K}/status-updates", () => undefined],
  [
    "POST",
    "/projects/{K}/status-updates",
    () => ({ body: "x", health: "at_risk" }),
  ],
  ["GET", "/issues?projectId={K}", () => undefined],
  ["POST", "/issues", (k) => ({ projectId: k, title: "t" })],
  ["GET", "/issues/{K}-1", () => undefined],
  ["PATCH", "/issues/{K}-1", () => ({ title: "t2" })],
  ["GET", "/issues/{K}-1/comments", () => undefined],
  ["POST", "/issues/{K}-1/comments", () => ({ body: "c" })],
  ["GET", "/activity?projectId={K}", () => undefined],
];

test("a project outside the key's projects answers exactly as one that doesn't exist, on every keyed route", async () => {
  const k = projectKey();
  const snapshot = () =>
    Promise.all(
      keyed.map(async ([method, template, json]) => {
        const res = await request(
          method,
          `/api/v1${template.replaceAll("{K}", k)}`,
          { key: scoped.key, json: json(k) },
        );
        return {
          route: `${method} ${template}`,
          status: res.status,
          headers: [...res.headers],
          body: await res.text(),
        };
      }),
    );
  const missing = await snapshot();
  await hiddenProject(k);
  const hidden = await snapshot();

  expect(hidden).toEqual(missing);
  for (const row of missing) expect(row.status, row.route).toBe(404);
});

test("a hidden project or issue named by its id answers as a missing id does", async () => {
  const { project, issue } = await hiddenProject();
  const missingId = "01J00000000000000000000000";
  for (const [path, id] of [
    ["/projects/{id}", project.id],
    ["/issues/{id}", issue.id],
  ] as const) {
    const as = async (ref: string) => {
      const res = await request("GET", `/api/v1${path.replace("{id}", ref)}`, {
        key: scoped.key,
      });
      return { status: res.status, body: (await res.text()).replace(ref, "") };
    };
    expect(await as(id), path).toEqual(await as(missingId));
  }
});

/** Every item of a paged GET as `key`, following `param` (cursor or after) until the end. */
async function everyItem(path: string, key: string, param = "cursor") {
  const items: Body[] = [];
  let next: string | null = param === "after" ? "" : null;
  for (let pages = 0; pages < 50; pages++) {
    const sep = path.includes("?") ? "&" : "?";
    const query =
      next === null ? "" : `${sep}${param}=${encodeURIComponent(next)}`;
    const res = await request("GET", `/api/v1${path}${query}`, { key });
    expect(res.status, path).toBe(200);
    const page = (await res.json()) as Body;
    if (param === "after" && page.items.length === 0) return items;
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    next = page.nextCursor;
  }
  throw new Error(`${path} did not end`);
}

test("lists show a scoped key only its projects and their issues", async () => {
  const b = await hiddenProject();
  const projects = await everyItem("/projects?limit=1", scoped.key);
  expect(projects.map((p) => p.key)).toEqual([a.key]);
  const all = await everyItem("/issues", (await unscopedKey()).key);
  const inA = all.filter((i) => i.projectId === a.id).map((i) => i.key);
  // the unscoped list is live: it holds the hidden issue and A's own
  expect(all.map((i) => i.key)).toContain(b.issue.key);
  expect(inA).toContain(issueA);
  const issues = await everyItem("/issues?limit=1", scoped.key);
  expect(issues.map((i) => i.key)).toEqual(inA);
});

test("a scoped key's activity pages past hidden and projectless events, newest first and oldest first", async () => {
  const b = await hiddenProject();
  // interleave: A, B, A, B, ... so every page boundary has hidden events beside it
  for (let i = 0; i < 3; i++) {
    await seed("POST", `/api/v1/issues/${issueA}/comments`, { body: `a${i}` });
    await seed("POST", `/api/v1/issues/${b.issue.key}/comments`, {
      body: `b${i}`,
    });
    db.insert(activityEvent)
      .values({
        actorId: bot.actor.id,
        subjectType: "project",
        subjectId: "none",
        projectId: null,
        action: "test.projectless",
      })
      .run();
  }
  const unscoped = await unscopedKey();
  const everything = await everyItem("/activity", unscoped.key);
  const inA = everything.filter((e) => e.projectId === a.id);
  expect(everything.some((e) => e.projectId === null)).toBe(true);
  expect(everything.some((e) => e.projectId === b.project.id)).toBe(true);

  const newestFirst = await everyItem("/activity?limit=2", scoped.key);
  expect(newestFirst.map((e) => e.id)).toEqual(inA.map((e) => e.id));
  const oldestFirst = await everyItem("/activity?limit=2", scoped.key, "after");
  expect(oldestFirst.map((e) => e.id)).toEqual(inA.map((e) => e.id).reverse());
});

let unscopedBots = 0;
const unscopedKey = async () => createBot(db, `unscoped ${++unscopedBots}`);

type Gated = {
  route: string;
  action: string;
  json?: () => unknown;
};
let made = 0;
const importBody = () => ({
  externalRef: `ext-${++made}`,
  key: projectKey(),
  name: "imported",
  issues: [],
  statusUpdates: [],
});
/** One row per route a key's actions gate, the paths in project A and its issue. */
const gated = (): Gated[] => [
  { route: "GET /projects", action: "read" },
  { route: `GET /projects/${a.key}`, action: "read" },
  { route: `GET /projects/${a.key}/labels`, action: "read" },
  { route: `GET /projects/${a.key}/status-updates`, action: "read" },
  { route: "GET /issues", action: "read" },
  { route: `GET /issues/${issueA}`, action: "read" },
  { route: `GET /issues/${issueA}/comments`, action: "read" },
  { route: "GET /activity", action: "read" },
  {
    route: "POST /issues",
    action: "issues",
    json: () => ({ projectId: a.key, title: `t${++made}` }),
  },
  {
    route: `PATCH /issues/${issueA}`,
    action: "issues",
    json: () => ({ title: `t${++made}`, addLabels: [`l${made}`] }),
  },
  {
    route: `POST /issues/${issueA}/comments`,
    action: "comments",
    json: () => ({ body: "hi" }),
  },
  {
    route: `POST /projects/${a.key}/status-updates`,
    action: "status_updates",
    json: () => ({ body: "ok", health: "on_track" }),
  },
  {
    route: "POST /projects",
    action: "admin",
    json: () => ({ key: projectKey(), name: "new" }),
  },
  {
    route: `PATCH /projects/${a.key}`,
    action: "admin",
    json: () => ({ description: `d${++made}` }),
  },
  {
    route: `POST /projects/${a.key}/labels`,
    action: "admin",
    json: () => ({ name: `label ${++made}` }),
  },
  { route: "POST /import", action: "admin", json: importBody },
  { route: "GET /bots", action: "admin" },
];

const send = (row: Gated, key: string) => {
  const [method, path] = row.route.split(" ") as [string, string];
  return request(method, `/api/v1${path}`, { key, json: row.json?.() });
};

test.each(["read", "issues", "comments", "status_updates", "admin"])(
  "a key with only %s passes exactly the routes that need it",
  async (action) => {
    const only = createBot(db, `only ${action}`, {
      scope: { actions: [action] },
    });
    for (const row of gated()) {
      const res = await send(row, only.key);
      const body = (await res.json()) as Body;
      if (row.action === action) {
        expect([200, 201], row.route).toContain(res.status);
      } else {
        expect([res.status, body.error?.code], row.route).toEqual([
          403,
          "forbidden_action",
        ]);
        expect(body.error.message, row.route).toContain(
          `needs the ${row.action} action`,
        );
      }
    }
  },
);

test("whoami answers every key, whatever its actions", async () => {
  const only = createBot(db, "whoami comments", {
    scope: { actions: ["comments"] },
  });
  expect(
    (await request("GET", "/api/v1/whoami", { key: only.key })).status,
  ).toBe(200);
});

test("an action the key lacks is a 403 naming it, the key's actions and whom to ask", async () => {
  const res = await request(
    "POST",
    `/api/v1/projects/${a.key}/status-updates`,
    {
      key: scoped.key,
      json: { body: "ok", health: "on_track" },
    },
  );
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: {
      code: "forbidden_action",
      message:
        "this key may not post a status update: that needs the status_updates action, and the key has read, issues and comments. Ask whoever minted the key for one with the status_updates action.",
    },
  });
});

test("a key scoped to A with read, issues and comments writes issues and comments in A", async () => {
  const filed = await request("POST", "/api/v1/issues", {
    key: scoped.key,
    json: { projectId: a.key, title: "by ivy", labels: ["ivy"] },
  });
  expect(filed.status).toBe(201);
  const { key } = (await filed.json()) as Body;
  const updated = await request("PATCH", `/api/v1/issues/${key}`, {
    key: scoped.key,
    json: { status: "in_progress", addLinks: [{ url: "https://x.test/1" }] },
  });
  expect(updated.status).toBe(200);
  const commented = await request("POST", `/api/v1/issues/${key}/comments`, {
    key: scoped.key,
    json: { body: "on it" },
  });
  expect(commented.status).toBe(201);
});

test("a key scoped to A with the status_updates and admin actions posts, labels and patches A", async () => {
  const manager = createBot(db, "scoped manager", {
    scope: { projects: [a.key], actions: ["read", "status_updates", "admin"] },
  });
  const as = (method: string, path: string, json: unknown) =>
    request(method, `/api/v1/projects/${a.key}${path}`, {
      key: manager.key,
      json,
    });

  const posted = await as("POST", "/status-updates", {
    body: "scoped update",
    health: "at_risk",
  });
  expect(posted.status).toBe(201);
  const updates = await as("GET", "/status-updates", undefined);
  expect(
    ((await updates.json()) as Body).items.map((u: Body) => u.body),
  ).toContain("scoped update");

  const labelled = await as("POST", "/labels", { name: "scoped label" });
  expect(labelled.status).toBe(201);
  const labels = await as("GET", "/labels", undefined);
  expect(
    ((await labels.json()) as Body).items.map((l: Body) => l.name),
  ).toContain("scoped label");

  const patched = await as("PATCH", "", { description: "set by manager" });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as Body).description).toBe("set by manager");
});

test("a key with an action list and no project list reaches every project", async () => {
  const b = await hiddenProject();
  const reader = createBot(db, "reader", { scope: { actions: ["read"] } });
  const res = await request("GET", `/api/v1/issues/${b.issue.key}`, {
    key: reader.key,
  });
  expect(res.status).toBe(200);
});

test("a key limited to projects can't create one, even with admin, and learns nothing of a taken key", async () => {
  const b = await hiddenProject();
  const admin = createBot(db, "scoped admin", {
    scope: { projects: [a.key] },
  });
  const refusal = {
    error: {
      code: "forbidden_scope",
      message: `this key may not create a project: it reaches only project ${a.key}. Ask whoever minted the key for one with no project list.`,
    },
  };
  for (const key of [projectKey(), b.project.key]) {
    const res = await request("POST", "/api/v1/projects", {
      key: admin.key,
      json: { key, name: "new" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(refusal);
  }
});

test("a key limited to projects imports into them, and an import outside them is refused alike whether the project exists or not", async () => {
  const unscoped = await unscopedKey();
  const imported = (externalRef: string, key: string) => ({
    externalRef,
    key,
    name: "imported",
    issues: [],
    statusUpdates: [],
  });
  const inside = projectKey();
  const outside = projectKey();
  for (const [ref, key] of [
    ["ext-inside", inside],
    ["ext-outside", outside],
  ]) {
    const res = await request("POST", "/api/v1/import", {
      key: unscoped.key,
      json: imported(ref as string, key as string),
    });
    expect(res.status).toBe(200);
  }
  const importer = createBot(db, "scoped importer", {
    scope: { projects: [inside, a.key], actions: ["admin"] },
  });
  const again = await request("POST", "/api/v1/import", {
    key: importer.key,
    json: { ...imported("ext-inside", inside), name: "renamed" },
  });
  expect(again.status).toBe(200);
  const renamed = await request("GET", `/api/v1/projects/${inside}`, {
    key: unscoped.key,
  });
  expect(((await renamed.json()) as Body).name).toBe("renamed");

  const refusal = {
    error: {
      code: "forbidden_scope",
      message: `this key may not import a project outside projects ${[a.key, inside].sort().join(" and ")}. Ask whoever minted the key for one that lists the project, or no project list.`,
    },
  };
  for (const json of [
    imported("ext-outside", outside),
    imported("ext-new", projectKey()),
    imported("ext-taken", inside),
  ]) {
    const res = await request("POST", "/api/v1/import", {
      key: importer.key,
      json,
    });
    expect([res.status, await res.json()], json.externalRef).toEqual([
      403,
      refusal,
    ]);
  }
});

test("whoami reports the calling key's scope, null where it is unrestricted", async () => {
  const scopedMe = await request("GET", "/api/v1/whoami", { key: scoped.key });
  expect(await scopedMe.json()).toEqual({
    id: scoped.actor.id,
    kind: "bot",
    name: "bg-ivy",
    label: null,
    scope: { projects: [a.key], actions: ["read", "issues", "comments"] },
    photoUrl: null,
    title: null,
  });
  const unscopedMe = await request("GET", "/api/v1/whoami", {
    key: (await unscopedKey()).key,
  });
  expect(((await unscopedMe.json()) as Body).scope).toEqual({
    projects: null,
    actions: null,
  });
});

test("the spec documents each gated operation's 403 with the action it needs", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<
      string,
      Record<string, { responses: Record<string, { description: string }> }>
    >;
  };
  const forbidden = Object.fromEntries(
    Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => [
        `${method.toUpperCase()} ${path}`,
        op.responses["403"]?.description ?? null,
      ]),
    ),
  );
  const needs = (action: string) =>
    `The key lacks the ${action} action (code forbidden_action)`;
  const orScope = (action: string) =>
    `${needs(action)}, or reaches only some projects (code forbidden_scope)`;
  expect(forbidden).toEqual({
    "GET /activity": needs("read"),
    "GET /bots": needs("admin"),
    "GET /issues": needs("read"),
    "GET /issues/{id}": needs("read"),
    "GET /issues/{id}/comments": needs("read"),
    "GET /projects": needs("read"),
    "GET /projects/{id}": needs("read"),
    "GET /projects/{id}/labels": needs("read"),
    "GET /projects/{id}/status-updates": needs("read"),
    "GET /whoami": null,
    "GET /photos/{actorId}/{hash}": null,
    "DELETE /me/photo": null,
    "PUT /me/photo": null,
    "DELETE /me/title": null,
    "PUT /me/title": null,
    "PATCH /issues/{id}": needs("issues"),
    "PATCH /projects/{id}": needs("admin"),
    "POST /import": orScope("admin"),
    "POST /issues": needs("issues"),
    "POST /issues/{id}/comments": needs("comments"),
    "POST /projects": orScope("admin"),
    "POST /projects/{id}/labels": needs("admin"),
    "POST /projects/{id}/status-updates": needs("status_updates"),
    "GET /webhooks": needs("read"),
    "POST /webhooks": needs("read"),
    "GET /webhooks/{id}": needs("read"),
    "PATCH /webhooks/{id}": needs("read"),
    "DELETE /webhooks/{id}": needs("read"),
    "PUT /webhooks/{id}/secret": needs("read"),
    "POST /webhooks/{id}/ping": needs("read"),
  });
});

test("a hidden issue named by its source key answers as a missing source key does", async () => {
  const lookup = async (key: string) => {
    const res = await request("GET", "/api/v1/issues/LIN-77", { key });
    return { status: res.status, body: await res.text() };
  };
  const missing = await lookup(scoped.key);
  const res = await request("POST", "/api/v1/import", {
    json: {
      externalRef: "ext-source-key",
      key: projectKey(),
      name: "hidden import",
      issues: [
        {
          externalRef: "lin-77",
          sourceKey: "LIN-77",
          title: "hidden",
          status: "Todo",
          createdAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    },
  });
  expect(res.status).toBe(200);
  expect((await lookup((await unscopedKey()).key)).status).toBe(200);
  expect(await lookup(scoped.key)).toEqual(missing);
  expect(missing.status).toBe(404);
});

test("an import whose source key a hidden issue holds is refused naming nothing of it, and a visible holder is still named", async () => {
  const unscoped = await unscopedKey();
  const withIssue = (
    externalRef: string,
    key: string,
    issueRef: string,
    sourceKey: string,
  ) => ({
    externalRef,
    key,
    name: "imported",
    issues: [
      {
        externalRef: issueRef,
        sourceKey,
        title: "t",
        status: "Todo",
        createdAt: "2026-01-02T03:04:05.000Z",
      },
    ],
  });
  const inside = projectKey();
  const held = {
    hidden: await seed(
      "POST",
      "/api/v1/import",
      withIssue(`ext-${projectKey()}`, projectKey(), "hid-501", "LIN-501"),
    ),
    visible: await seed(
      "POST",
      "/api/v1/import",
      withIssue(`ext-${inside}`, inside, "vis-502", "LIN-502"),
    ),
  };
  expect(held.hidden.created.issues).toBe(1);
  expect(held.visible.created.issues).toBe(1);
  const holderId = async (sourceKey: string) =>
    (
      (await (
        await request("GET", `/api/v1/issues/${sourceKey}`, {
          key: unscoped.key,
        })
      ).json()) as Body
    ).id as string;
  const hiddenId = await holderId("LIN-501");
  const visibleId = await holderId("LIN-502");

  const importer = createBot(db, "scoped source-key importer", {
    scope: { projects: [inside], actions: ["admin"] },
  });
  const attempt = async (key: string, sourceKey: string) => {
    const res = await request("POST", "/api/v1/import", {
      key,
      json: withIssue(`ext-${inside}`, inside, "new-503", sourceKey),
    });
    return { status: res.status, body: await res.text() };
  };
  const named = (id: string, ref: string, sourceKey: string) =>
    JSON.stringify({
      error: {
        code: "conflict",
        message: `issue new-503 sends sourceKey ${sourceKey}, but issue ${id} (externalRef ${ref}) already has it: a source key names one issue, so send each issue its own Linear identifier`,
      },
    });

  const hidden = await attempt(importer.key, "LIN-501");
  expect(hidden.status).toBe(409);
  expect(hidden.body).not.toContain(hiddenId);
  expect(hidden.body).not.toContain("hid-501");
  expect(JSON.parse(hidden.body)).toEqual({
    error: {
      code: "conflict",
      message:
        "issue new-503 sends sourceKey LIN-501, but another issue already has it: a source key names one issue, so send each issue its own Linear identifier",
    },
  });
  expect(await attempt(importer.key, "LIN-502")).toEqual({
    status: 409,
    body: named(visibleId, "vis-502", "LIN-502"),
  });
  expect(await attempt(unscoped.key, "LIN-501")).toEqual({
    status: 409,
    body: named(hiddenId, "hid-501", "LIN-501"),
  });
});
