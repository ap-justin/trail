import { and, eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { activityEvent, issue } from "../db/schema.js";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { db, request, signIn, owner, addProject, addBot, addMember, bot } =
  setupTestApp();
const ownerCookie = await signIn(owner);
const seed = webSeed(request);

const get = (path: string, cookie = ownerCookie) => seed.get(path, cookie);

const v1 = (method: string, path: string, json?: unknown, key?: string) =>
  request(method, `/api/v1${path}`, { json, key });

const tester = {
  id: bot.actor.id,
  name: "tester",
  kind: "bot",
  photoUrl: null,
  title: null,
};

test("an issue reads with its type, product and fields, its people as actors, and a timeline oldest first with one entry per changed field", async () => {
  const p = addProject("Detail");
  const worker = addBot("worker");
  const [created] = await atFakeTimeAsync([
    () =>
      v1("POST", "/issues", {
        projectId: p.id,
        title: "Fix it",
        description: "details",
        labels: ["bug"],
        links: [{ url: "https://example.com/1", title: "one" }],
      }),
  ]);
  const { id } = (await (created as Response).json()) as { id: string };
  await atFakeTimeAsync([
    () =>
      v1("PATCH", `/issues/${id}`, {
        status: "in_progress",
        priority: 2,
        assigneeId: worker.actor.id,
        estimate: 3,
      }),
    () => v1("POST", `/issues/${id}/comments`, { body: "on it" }, worker.key),
    () =>
      v1("PATCH", `/issues/${id}`, {
        addLabels: ["ui"],
        removeLabels: ["bug"],
        addLinks: [{ url: "https://example.com/2", title: "two" }],
        assigneeId: null,
        estimate: null,
      }),
    // neither a removed link nor a renamed title is a timeline entry
    () =>
      v1("PATCH", `/issues/${id}`, {
        title: "Fix it now",
        removeLinks: ["https://example.com/1"],
      }),
  ]);

  const { status, body } = await get(`/items/${p.key}-1`);
  expect(status).toBe(200);
  const { timeline, ...fields } = body;
  expect(fields).toEqual({
    key: `${p.key}-1`,
    type: "issue",
    sourceKey: null,
    product: { key: p.key, name: "Detail" },
    projects: [],
    title: "Fix it now",
    description: "details",
    status: "in_progress",
    priority: 2,
    estimate: null,
    labels: ["ui"],
    links: [{ url: "https://example.com/2", title: "two" }],
    assignee: null,
    creator: tester,
    sourceAuthor: null,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    completedAt: null,
    about: [],
    notes: [],
    notesCount: { current: 0, archived: 0 },
  });
  const workerActor = {
    id: worker.actor.id,
    name: "worker",
    kind: "bot",
    photoUrl: null,
    title: null,
  };
  const item = { key: `${p.key}-1`, title: "Fix it now", type: "issue" };
  const product = { key: p.key, name: "Detail" };
  const project = null;
  expect(
    timeline.map(({ id: _, createdAt: __, ...rest }: Body) => rest),
  ).toEqual([
    {
      kind: "item_created",
      actor: tester,
      product,
      project,
      item,
      sourceAuthor: null,
      createdAs: "issue",
    },
    {
      kind: "status_changed",
      actor: tester,
      product,
      project,
      item,
      from: "triage",
      to: "in_progress",
    },
    {
      kind: "priority_changed",
      actor: tester,
      product,
      project,
      item,
      from: 0,
      to: 2,
    },
    {
      kind: "assignee_changed",
      actor: tester,
      product,
      project,
      item,
      from: null,
      to: workerActor,
    },
    {
      kind: "estimate_changed",
      actor: tester,
      product,
      project,
      item,
      from: null,
      to: 3,
    },
    {
      kind: "comment",
      actor: workerActor,
      product,
      project,
      item,
      comment: { id: expect.any(String), body: "on it", sourceAuthor: null },
    },
    {
      kind: "labels_changed",
      actor: tester,
      product,
      project,
      item,
      added: ["ui"],
      removed: ["bug"],
    },
    {
      kind: "link_added",
      actor: tester,
      product,
      project,
      item,
      link: { url: "https://example.com/2", title: "two" },
    },
    {
      kind: "assignee_changed",
      actor: tester,
      product,
      project,
      item,
      from: workerActor,
      to: null,
    },
    {
      kind: "estimate_changed",
      actor: tester,
      product,
      project,
      item,
      from: 3,
      to: null,
    },
  ]);
  expect(new Set(timeline.map((e: Body) => e.id)).size).toBe(timeline.length);
});

test("an imported issue is found by its source key and credits the importing bot, with the source authors beside it", async () => {
  const importer = addBot("importer");
  const res = await v1(
    "POST",
    "/import",
    {
      externalRef: "proj-alias",
      key: "ALIAS",
      name: "Alias",
      issues: [
        {
          externalRef: "iss-1",
          sourceKey: "ABC-187",
          title: "From Linear",
          status: "Todo",
          createdAt: "2026-01-02T03:04:05.000Z",
          sourceAuthor: "Jane",
          comments: [
            {
              externalRef: "c-1",
              body: "imported comment",
              createdAt: "2026-01-03T03:04:05.000Z",
              sourceAuthor: "Joe",
            },
          ],
        },
      ],
    },
    importer.key,
  );
  expect(res.status).toBe(200);

  const { status, body } = await get("/items/abc-187");
  expect(status).toBe(200);
  const importerActor = {
    id: importer.actor.id,
    name: "importer",
    kind: "bot",
    photoUrl: null,
    title: null,
  };
  expect(body).toMatchObject({
    key: "ALIAS-1",
    sourceKey: "ABC-187",
    creator: importerActor,
    sourceAuthor: "Jane",
  });
  expect(body.timeline).toMatchObject([
    {
      kind: "item_created",
      actor: importerActor,
      sourceAuthor: "Jane",
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    {
      kind: "comment",
      actor: importerActor,
      comment: { body: "imported comment", sourceAuthor: "Joe" },
    },
  ]);
});

test("a todo reads as type todo, and its timeline shows it being added to and removed from projects", async () => {
  const p = addProject("Planned");
  const [key] = await atFakeTimeAsync([() => seed.item(p.key, "todo")]);
  const [slug] = await atFakeTimeAsync([
    () => seed.project("Launch", [p.key], [key as string]),
  ]);
  await atFakeTimeAsync<unknown>([
    () => seed.project("Polish", [p.key], [key as string]),
    () => v1("DELETE", `/projects/${slug}/items/${key}`),
  ]);

  const { body } = await get(`/items/${key}`);

  expect(body).toMatchObject({
    type: "todo",
    assignee: { name: "tester" },
    projects: [{ slug: "polish", name: "Polish" }],
  });
  expect(
    body.timeline.map((e: Body) => [e.kind, e.project?.slug ?? null]),
  ).toEqual([
    ["item_created", null],
    ["added_to_project", "launch"],
    ["added_to_project", "polish"],
    ["removed_from_project", "launch"],
  ]);
  expect(body.timeline[1]).toMatchObject({
    actor: tester,
    product: { key: p.key, name: "Planned" },
    project: { slug: "launch", name: "Launch" },
    item: { key, title: `todo ${p.key}`, type: "todo" },
  });
});

test("accepting an issue as a todo is a type change on the timeline", async () => {
  const p = addProject("Accept");
  const key = await seed.item(p.key, "issue");
  await v1("PATCH", `/items/${key}`, { type: "todo" });
  const { body } = await get(`/items/${key}`);
  expect(body.type).toBe("todo");
  expect(
    body.timeline
      .filter((e: Body) => e.kind === "type_changed")
      .map((e: Body) => [e.from, e.to]),
  ).toEqual([["issue", "todo"]]);
});

test("a member sees an item's project that also draws from a product they can't see, and nothing of that product", async () => {
  const seen = addProject("Seen");
  const unseen = addProject("Unseen");
  const key = await seed.item(seen.key, "issue");
  const other = await seed.item(unseen.key, "issue");
  await seed.project("Across", [seen.key, unseen.key], [key, other]);
  const cookie = await addMember("crosser", [seen.id]);

  const res = await request("GET", `/api/web/items/${key}`, {
    key: null,
    cookie,
  });
  const text = await res.text();

  expect(res.status).toBe(200);
  expect(JSON.parse(text).projects).toEqual([
    { slug: "across", name: "Across" },
  ]);
  expect(text).not.toContain(unseen.key);
  expect(text).not.toContain("Unseen");
});

test("an item of a product the member can't see is the same 404 as a missing one", async () => {
  const hidden = addProject("Hidden");
  const key = await seed.item(hidden.key, "issue");
  const cookie = await addMember("outsider", []);
  const found = await get(`/items/${key}`, cookie);
  const missing = await get("/items/NOPE-1", cookie);
  expect(found.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(found.body.error.message).toBe(`no item ${key}`);
  expect(missing.body.error.message).toBe("no item NOPE-1");
});

test("an item's key reads it in lower case and with its number zero-padded", async () => {
  const p = addProject("Padded");
  const key = await seed.item(p.key, "issue");
  const [prefix, number] = key.split("-") as [string, string];
  for (const ref of [
    key.toLowerCase(),
    `${prefix}-00${number}`,
    `${prefix.toLowerCase()}-0${number}`,
  ]) {
    const { status, body } = await get(`/items/${ref}`);
    expect(status, ref).toBe(200);
    expect(body.key, ref).toBe(key);
  }
});

test("the created entry carries the type the item was created with, on the timeline and in the feed, whatever its type now", async () => {
  const p = addProject("Created as");
  const issue = await seed.item(p.key, "issue");
  await v1("PATCH", `/items/${issue}`, { type: "todo" });
  const todo = await seed.item(p.key, "todo");

  const feed = (await get(`/feed?product=${p.key}`)).body.items as Body[];
  for (const [key, createdAs] of [
    [issue, "issue"],
    [todo, "todo"],
  ]) {
    const { body } = await get(`/items/${key}`);
    expect(body.timeline[0], key).toMatchObject({
      kind: "item_created",
      createdAs,
    });
    expect(
      feed.find((e) => e.kind === "item_created" && e.item.key === key),
      key,
    ).toMatchObject({ createdAs });
  }
});

test("a created entry stored before events recorded the type reads issue when a person filed it, else the item's type now", async () => {
  const p = addProject("Created before");
  const filed = await request("POST", "/api/web/issues", {
    key: null,
    cookie: ownerCookie,
    json: { product: p.key, title: "filed by a person" },
  });
  expect(filed.status).toBe(201);
  const byPerson = ((await filed.json()) as Body).key as string;
  const byBot = await seed.item(p.key, "issue");
  for (const key of [byPerson, byBot]) {
    await v1("PATCH", `/items/${key}`, { type: "todo" });
  }
  const ids = db
    .select({ id: issue.id })
    .from(issue)
    .where(eq(issue.productId, p.id))
    .all()
    .map((r) => r.id);
  for (const id of ids) {
    db.update(activityEvent)
      .set({ payload: sql`json_remove(${activityEvent.payload}, '$.type')` })
      .where(
        and(
          eq(activityEvent.subjectId, id),
          eq(activityEvent.action, "issue.created"),
        ),
      )
      .run();
  }

  const feed = (await get(`/feed?product=${p.key}`)).body.items as Body[];
  for (const [key, createdAs] of [
    [byPerson, "issue"],
    [byBot, "todo"],
  ]) {
    const { body } = await get(`/items/${key}`);
    expect(body.timeline[0], key).toMatchObject({
      kind: "item_created",
      createdAs,
    });
    expect(
      feed.find((e) => e.kind === "item_created" && e.item.key === key),
      key,
    ).toMatchObject({ createdAs });
  }
});
