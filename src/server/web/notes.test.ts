import { beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { request, addMember, addProject, addBot } = setupTestApp();
const { get, item, project } = webSeed(request);

// Alpha, which the member sees, holds a todo, an issue and two notes, one archived; Hidden, which they don't, a todo a note is about.
let alpha: { id: string; key: string };
let member = "";
let keys: Record<string, string> = {};
let slug = "";
beforeAll(async () => {
  alpha = addProject("Alpha");
  const hidden = addProject("Hidden");
  const writer = addBot("note writer");
  const todo = await item(alpha.key, "todo");
  const issue = await item(alpha.key, "issue");
  const secret = await item(hidden.key, "todo");
  const note = async (title: string, about: string[]) => {
    const res = await request("POST", "/api/v1/items", {
      json: { type: "note", product: alpha.key, title, about },
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
  keys = { todo, issue, secret, current, archived };
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
