import { beforeAll, expect, test } from "vitest";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { request, addMember, addProject, addBot, bot } = setupTestApp();
const { get, item, project } = webSeed(request);

// Alpha, which the member sees, holds a todo, an issue and two notes, one archived; Hidden, which they don't, a todo a note is about and a note about Alpha's todo and issue.
let alpha: { id: string; key: string };
let member = "";
let hiddenId = "";
let hiddenKey = "";
let keys: Record<string, string> = {};
let slug = "";
beforeAll(async () => {
  alpha = addProject("Alpha");
  const hidden = addProject("Hidden");
  hiddenId = hidden.id;
  hiddenKey = hidden.key;
  const writer = addBot("note writer");
  const todo = await item(alpha.key, "todo");
  const issue = await item(alpha.key, "issue");
  const secret = await item(hidden.key, "todo");
  const note = async (title: string, about: string[], product = alpha.key) => {
    const res = await request("POST", "/api/v1/items", {
      json: { type: "note", product, title, about },
      key: writer.key,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as Body).key as string;
  };
  const current = await note("current note", [todo, secret]);
  const archived = await note("archived note", []);
  const archive = await request("PATCH", `/api/v1/items/${archived}`, {
    json: { status: "archived" },
    key: writer.key,
  });
  expect(archive.status).toBe(200);
  const hiddenNote = await note("private note", [todo, issue], hidden.key);
  keys = { todo, issue, secret, current, archived, hiddenNote };
  slug = await project("Noted", [alpha.key], [todo, issue, current, archived]);
  member = await addMember("reader", [alpha.id]);
});

const workCounts = {
  all: { all: 2, open: 2, in_progress: 0, done: 0, canceled: 0 },
  issue: { all: 1, open: 1, in_progress: 0, done: 0, canceled: 0 },
  todo: { all: 1, open: 1, in_progress: 0, done: 0, canceled: 0 },
  notes: { current: 1, archived: 1 },
};

test("a product's item list leaves notes out unless type note asks for them, and counts them apart", async () => {
  const all = await get(`/products/${alpha.key}/items`, member);
  expect(all.status).toBe(200);
  expect(all.body.items.map((i: Body) => i.key).sort()).toEqual(
    [keys.todo, keys.issue].sort(),
  );
  expect(all.body.counts).toEqual(workCounts);
  const current = await get(
    `/products/${alpha.key}/items?type=note&status=current`,
    member,
  );
  expect(current.body.items).toEqual([
    expect.objectContaining({
      key: keys.current,
      type: "note",
      status: "current",
      assignee: null,
    }),
  ]);
});

test("a project's item groups leave notes out unless type note asks for them, and count them apart", async () => {
  const all = await get(`/projects/${slug}/items`, member);
  expect(
    all.body.groups
      .flatMap((g: Body) => g.items.map((i: Body) => i.key))
      .sort(),
  ).toEqual([keys.todo, keys.issue].sort());
  expect(all.body.groups[0].count).toBe(2);
  expect(all.body.counts).toEqual(workCounts);
  const archived = await get(
    `/projects/${slug}/items?type=note&status=archived`,
    member,
  );
  expect(
    archived.body.groups.flatMap((g: Body) => g.items.map((i: Body) => i.key)),
  ).toEqual([keys.archived]);
});

test("a note's page lists the items it is about that the viewer sees; an item's page lists the notes about it", async () => {
  const note = await get(`/items/${keys.current}`, member);
  expect(note.body).toMatchObject({
    type: "note",
    status: "current",
    assignee: null,
    about: [{ key: keys.todo, type: "todo", status: "open" }],
    notes: [],
  });
  expect(JSON.stringify(note.body)).not.toContain(keys.secret);
  const todo = await get(`/items/${keys.todo}`, member);
  expect(todo.body).toMatchObject({
    about: [],
    notes: [
      {
        key: keys.current,
        title: "current note",
        type: "note",
        status: "current",
      },
    ],
  });
});

test("a note's page lists several visible items it is about in key order, whatever order they were created or named in", async () => {
  const wide = addProject("Wide");
  const writer = addBot("wide writer");
  const [first, second, third] = await atFakeTimeAsync([
    () => item(wide.key, "todo"),
    () => item(wide.key, "issue"),
    () => item(wide.key, "todo"),
  ]);
  const res = await request("POST", "/api/v1/items", {
    json: {
      type: "note",
      product: wide.key,
      title: "spans three",
      about: [third, first, second],
    },
    key: writer.key,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const reader = await addMember("widereader", [wide.id]);
  const page = await get(`/items/${((await res.json()) as Body).key}`, reader);
  expect(page.body.about.map((a: Body) => a.key)).toEqual([
    first,
    second,
    third,
  ]);
});

test("an item's page lists the 50 newest current notes about it and counts every note the viewer sees in notesCount", async () => {
  const crowded = addProject("Crowded");
  const elsewhere = addProject("Elsewhere");
  const writer = addBot("crowd writer");
  const target = await item(crowded.key, "todo");
  const add = async (title: string, product = crowded.key) => {
    const res = await request("POST", "/api/v1/items", {
      json: { type: "note", product, title, about: [target] },
      key: writer.key,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as Body).key as string;
  };
  const added: string[] = [];
  added.push(
    ...(await atFakeTimeAsync(
      Array.from({ length: 52 }, (_, i) => () => add(`note ${i}`)),
    )),
  );
  const archive = await request("PATCH", `/api/v1/items/${added[51]}`, {
    json: { status: "archived" },
    key: writer.key,
  });
  expect(archive.status).toBe(200);
  await add("out of sight", elsewhere.key);
  const viewer = await addMember("crowdreader", [crowded.id]);
  const page = await get(`/items/${target}`, viewer);
  expect(page.body.notes.map((n: Body) => n.key)).toEqual(
    added.slice(1, 51).reverse(),
  );
  expect(page.body.notesCount).toEqual({ current: 51, archived: 1 });
});

test("search finds a note, with its type and status", async () => {
  const found = await get("/search?q=current%20note", member);
  expect(found.body.items).toEqual([
    expect.objectContaining({
      key: keys.current,
      type: "note",
      status: "current",
    }),
  ]);
});

test("the feed filters to notes by type", async () => {
  const feed = await get("/feed?type=note", member);
  expect(feed.status).toBe(200);
  const items = new Set(feed.body.items.map((e: Body) => e.item?.key));
  expect([...items].sort()).toEqual([keys.archived, keys.current].sort());
});

test("a note about an item the viewer can't reach never names it in the feed, search or the note's page", async () => {
  const feed = await get("/feed", member);
  expect(feed.body.items.map((e: Body) => e.item?.key)).toContain(keys.current);
  const found = await get("/search?q=current%20note", member);
  const page = await get(`/items/${keys.current}`, member);
  expect(page.body.about.map((r: Body) => r.key)).toEqual([keys.todo]);
  expect(JSON.stringify([feed.body, found.body, page.body])).not.toContain(
    keys.secret,
  );
});

test("a note in a product the viewer can't reach, about an item they see, is not on that item's page", async () => {
  const issue = await get(`/items/${keys.issue}`, member);
  expect(issue.body.notes).toEqual([]);
  const todo = await get(`/items/${keys.todo}`, member);
  expect(todo.body.notes.map((n: Body) => n.key)).toEqual([keys.current]);
  expect(JSON.stringify([issue.body, todo.body])).not.toContain("private note");
  // the same note shows for someone who reaches both products
  const reached = await addMember("bothreader", [alpha.id, hiddenId]);
  const seen = await get(`/items/${keys.issue}`, reached);
  expect(seen.body.notes.map((n: Body) => n.key)).toEqual([keys.hiddenNote]);
});

test("a note in a product the viewer can't reach is not found by its link, search or the product's note list", async () => {
  const direct = await get(`/items/${keys.hiddenNote}`, member);
  expect(direct.status).toBe(404);
  const found = await get("/search?q=private%20note", member);
  expect(found.status).toBe(200);
  expect(found.body.items).toEqual([]);
  const hidden = await request(
    "GET",
    `/api/web/products/${hiddenKey}/items?type=note`,
    {
      key: null,
      cookie: member,
    },
  );
  expect(hidden.status).toBe(404);
  expect(await hidden.text()).not.toContain("private note");
  // the same note is there for someone who reaches the product
  const reached = await addMember("hiddenreader", [hiddenId]);
  expect((await get(`/items/${keys.hiddenNote}`, reached)).status).toBe(200);
  expect(
    (await get("/search?q=private%20note", reached)).body.items.map(
      (i: Body) => i.key,
    ),
  ).toEqual([keys.hiddenNote]);
  expect(
    (
      await get(`/products/${hiddenKey}/items?type=note`, reached)
    ).body.items.map((i: Body) => i.key),
  ).toEqual([keys.hiddenNote]);
});

test("a person cannot file a note through the issue route, and no note appears", async () => {
  const res = await request("POST", "/api/web/issues", {
    key: null,
    cookie: member,
    json: { product: alpha.key, title: "human note", type: "note" },
  });
  expect(res.status).toBe(422);
  const listed = await get(`/products/${alpha.key}/items?type=note`, member);
  expect(listed.body.items.map((i: Body) => i.title).sort()).toEqual([
    "archived note",
    "current note",
  ]);
});

test("a person's session is refused at /api/v1/items for a note write, and the note stays as it was", async () => {
  const before = await get(`/items/${keys.current}`, member);
  expect(before.status).toBe(200);
  const created = await request("POST", "/api/v1/items", {
    key: null,
    cookie: member,
    json: { type: "note", product: alpha.key, title: "human note" },
  });
  const edited = await request("PATCH", `/api/v1/items/${keys.current}`, {
    key: null,
    cookie: member,
    json: { title: "edited by a person", status: "archived" },
  });
  expect([created.status, edited.status]).toEqual([401, 401]);
  expect(await get(`/items/${keys.current}`, member)).toEqual(before);
  const listed = await get(`/products/${alpha.key}/items?type=note`, member);
  expect(listed.body.items.map((i: Body) => i.title).sort()).toEqual([
    "archived note",
    "current note",
  ]);
});

test("a person comments on a note, and the comment is on its timeline", async () => {
  const res = await request("POST", `/api/web/items/${keys.current}/comments`, {
    key: null,
    cookie: member,
    json: { body: "thanks for recording this" },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const comment = (await res.json()) as Body;
  expect(comment).toMatchObject({
    kind: "comment",
    actor: { kind: "human" },
    item: { key: keys.current, type: "note" },
    comment: { body: "thanks for recording this" },
  });
  const page = await get(`/items/${keys.current}`, member);
  expect(page.body.timeline.filter((e: Body) => e.kind === "comment")).toEqual([
    expect.objectContaining({ id: comment.id }),
  ]);
});

test("turning a todo into a note shows its type and status change, not the priority, estimate and assignee it clears", async () => {
  // only a product's own bot converts, so the sending key's bot owns Alpha here
  await request("PATCH", `/api/v1/products/${alpha.key}`, {
    json: { owner: bot.actor.id },
  });
  const todo = await item(alpha.key, "todo", {
    priority: 2,
    estimate: 3,
    assignee: "note writer",
  });
  const retype = await request("PATCH", `/api/v1/items/${todo}`, {
    json: { type: "note" },
  });
  expect(retype.status, await retype.clone().text()).toBe(200);

  const page = await get(`/items/${todo}`, member);
  expect(page.body.timeline.map((e: Body) => e.kind)).toEqual([
    "item_created",
    "status_changed",
    "type_changed",
  ]);
  const feed = await get("/feed?type=note", member);
  expect(
    feed.body.items
      .filter((e: Body) => e.item?.key === todo)
      .map((e: Body) => e.kind),
  ).toEqual(["status_changed", "type_changed", "item_created"]);
});

test("an edit that only changes a note's about adds one timeline entry naming the items added and removed, and only counts other products' items", async () => {
  const own = addProject("Aboutness");
  const writer = addBot("about writer");
  const [kept, dropped, gained] = await atFakeTimeAsync([
    () => item(own.key, "todo"),
    () => item(own.key, "issue"),
    () => item(own.key, "todo"),
  ]);
  const created = await request("POST", "/api/v1/items", {
    json: {
      type: "note",
      product: own.key,
      title: "moving about",
      about: [kept, dropped],
    },
    key: writer.key,
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const note = ((await created.json()) as Body).key as string;
  const edit = await request("PATCH", `/api/v1/items/${note}`, {
    json: { about: [kept, gained, keys.secret] },
    key: writer.key,
  });
  expect(edit.status, await edit.clone().text()).toBe(200);

  const reader = await addMember("aboutreader", [own.id]);
  const page = await get(`/items/${note}`, reader);
  expect(page.body.timeline.map((e: Body) => e.kind)).toEqual([
    "item_created",
    "about_changed",
  ]);
  expect(page.body.timeline[1]).toMatchObject({
    actor: { name: "about writer" },
    item: { key: note },
    added: [gained],
    removed: [dropped],
    others: { from: 0, to: 1 },
  });
  expect(JSON.stringify(page.body.timeline)).not.toContain(keys.secret);
});

test("an edit changing a note's status and about shows the status change, then the about change, in the note's timeline order", async () => {
  const own = addProject("Mixed");
  const writer = addBot("mixed writer");
  const [first, second] = await atFakeTimeAsync([
    () => item(own.key, "todo"),
    () => item(own.key, "todo"),
  ]);
  let note = "";
  await atFakeTimeAsync([
    async () => {
      const res = await request("POST", "/api/v1/items", {
        json: {
          type: "note",
          product: own.key,
          title: "mixed",
          about: [first],
        },
        key: writer.key,
      });
      expect(res.status, await res.clone().text()).toBe(201);
      note = ((await res.json()) as Body).key as string;
    },
    async () => {
      const res = await request("PATCH", `/api/v1/items/${note}`, {
        json: { status: "archived", about: [second] },
        key: writer.key,
      });
      expect(res.status, await res.clone().text()).toBe(200);
    },
  ]);
  const reader = await addMember("mixedreader", [own.id]);
  const commented = await request("POST", `/api/web/items/${note}/comments`, {
    key: null,
    cookie: reader,
    json: { body: "after the edit" },
  });
  expect(commented.status).toBe(201);

  const page = await get(`/items/${note}`, reader);
  expect(page.body.timeline.map((e: Body) => e.kind)).toEqual([
    "item_created",
    "status_changed",
    "about_changed",
    "comment",
  ]);
  expect(page.body.timeline[2]).toMatchObject({
    added: [second],
    removed: [first],
    others: { from: 0, to: 0 },
  });
  const ids = page.body.timeline.map((e: Body) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});
