import { beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { request, addMember, addProject, addBot } = setupTestApp();
const { get, item, project } = webSeed(request);

// Alpha, which the member sees, holds a todo, an issue and two notes, one archived; Hidden, which they don't, a todo a note is about and a note about Alpha's todo and issue.
let alpha: { id: string; key: string };
let member = "";
let hiddenId = "";
let keys: Record<string, string> = {};
let slug = "";
beforeAll(async () => {
  alpha = addProject("Alpha");
  const hidden = addProject("Hidden");
  hiddenId = hidden.id;
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
    all.body.groups.flatMap((g: Body) => g.items.map((i: Body) => i.key)),
  ).toEqual(expect.arrayContaining([keys.todo, keys.issue]));
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
  for (let i = 0; i < 52; i++) added.push(await add(`note ${i}`));
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
