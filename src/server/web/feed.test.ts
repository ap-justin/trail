import { beforeAll, describe, expect, test } from "vitest";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";
import { webSeed } from "./test-seed.js";

const { request, addMember, addProject, addBot } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const v1 = (method: string, path: string, json?: unknown, key?: string) =>
  request(method, `/api/v1${path}`, { json, key });

describe("GET /feed", () => {
  const visible = addProject("Visible");
  const hidden = addProject("Hidden");
  const loud = addBot("loud");
  const secret = addBot("secret");
  let cookie = "";
  let visibleIssue = "";

  async function file(projectId: string, title: string, key?: string) {
    const res = await v1("POST", "/issues", { projectId, title }, key);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    cookie = await addMember("reader", [visible.id]);
    // interleaved, so hidden events sit between the visible ones in seq order
    const [first] = await atFakeTimeAsync([
      () => file(visible.id, "v1", loud.key),
      () => file(hidden.id, "h1", secret.key),
      () => file(hidden.id, "h2"),
    ]);
    visibleIssue = first as string;
    await atFakeTimeAsync<unknown>([
      () => v1("PATCH", `/issues/${visibleIssue}`, { status: "done" }),
      () => v1("PATCH", `/issues/${visibleIssue}`, { title: "renamed only" }),
      () => file(hidden.id, "h3"),
      () => v1("POST", `/issues/${visibleIssue}/comments`, { body: "hello" }),
      () => file(hidden.id, "h4"),
    ]);
  });

  const feed = async (query = "") => {
    const res = await request("GET", `/api/web/feed${query}`, {
      key: null,
      cookie,
    });
    return { status: res.status, body: (await res.json()) as Body };
  };

  test("shows only visible products' entries, newest first, and skips a change it has no entry for", async () => {
    const { status, body } = await feed();
    expect(status).toBe(200);
    expect(
      body.items.map((e: Body) => [e.kind, e.product.key, e.item?.title]),
    ).toEqual([
      ["comment", visible.key, "renamed only"],
      ["status_changed", visible.key, "renamed only"],
      ["item_created", visible.key, "renamed only"],
    ]);
    expect(body.nextCursor).toBeNull();
  });

  test("pages by limit with a cursor, and the last visible page has no cursor though hidden events are older", async () => {
    const kinds: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const { body } = await feed(`?limit=1${query}`);
      expect(body.items).toHaveLength(1);
      kinds.push(body.items[0].kind);
      cursor = body.nextCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(kinds).toEqual(["comment", "status_changed", "item_created"]);
  });

  test("offers as filters the bots that acted in visible products, the visible products and no project yet", async () => {
    const { body } = await feed();
    expect(body.filters).toEqual({
      actors: [
        {
          id: loud.actor.id,
          name: "loud",
          kind: "bot",
          photoUrl: null,
          title: null,
        },
        {
          id: expect.any(String),
          name: "tester",
          kind: "bot",
          photoUrl: null,
          title: null,
        },
      ],
      products: [{ key: visible.key, name: "Visible" }],
      projects: [],
    });
  });

  test("filters by actor and by product", async () => {
    const byActor = await feed(`?actor=${loud.actor.id}`);
    expect(byActor.body.items.map((e: Body) => e.kind)).toEqual([
      "item_created",
    ]);
    const byProduct = await feed(`?product=${visible.key.toLowerCase()}`);
    expect(byProduct.body.items).toHaveLength(3);
  });

  test("a cursor goes back only with the filters it was issued under", async () => {
    const { body } = await feed(`?limit=1&product=${visible.key}`);
    const res = await feed(`?limit=1&cursor=${body.nextCursor}`);
    expect(res.status).toBe(422);
  });
});

test("the bot filter lists each bot with an event in any visible product once, by name in binary order, and no human, hidden-only or idle bot", async () => {
  const first = addProject("Bots first");
  const second = addProject("Bots second");
  const elsewhere = addProject("Bots elsewhere");
  const beta = addBot("beta");
  const alpha = addBot("Alpha");
  const zed = addBot("Zed");
  const hiddenOnly = addBot("hidden-only");
  addBot("idle");
  const cookie = await addMember("bot-watcher", [first.id, second.id]);
  const file = (projectId: string, key: string) =>
    v1("POST", "/issues", { projectId, title: "t" }, key);
  await file(first.id, beta.key);
  await file(second.id, beta.key);
  await file(second.id, alpha.key);
  await file(first.id, zed.key);
  await file(elsewhere.id, hiddenOnly.key);
  const byHuman = await request("POST", "/api/web/issues", {
    key: null,
    cookie,
    json: { product: first.key, title: "by a person" },
  });
  expect(byHuman.status).toBe(201);

  const res = await request("GET", "/api/web/feed", { key: null, cookie });
  const body = (await res.json()) as Body;
  expect(body.filters.actors).toEqual([
    {
      id: alpha.actor.id,
      name: "Alpha",
      kind: "bot",
      photoUrl: null,
      title: null,
    },
    { id: zed.actor.id, name: "Zed", kind: "bot", photoUrl: null, title: null },
    {
      id: beta.actor.id,
      name: "beta",
      kind: "bot",
      photoUrl: null,
      title: null,
    },
  ]);
  // a person is no filter, and in the feed itself carries a title of null
  const personEvent = body.items.find((e: Body) => e.actor.kind === "human");
  expect(personEvent.actor).toEqual({
    id: expect.any(String),
    name: expect.any(String),
    kind: "human",
    photoUrl: null,
    title: null,
  });
});

describe("GET /feed with projects", () => {
  const seed = webSeed(request);
  const seen = addProject("Seen");
  const unseen = addProject("Unseen");
  let cookie = "";
  let seenItem = "";
  beforeAll(async () => {
    cookie = await addMember("project-reader", [seen.id]);
    const steps = await atFakeTimeAsync<unknown>([
      () => seed.item(seen.key, "todo"),
      () => seed.item(unseen.key, "issue"),
      () => seed.project("Across", [seen.key, unseen.key]),
      () => seed.project("Unseen only", [unseen.key]),
    ]);
    seenItem = steps[0] as string;
    const unseenItem = steps[1] as string;
    await atFakeTimeAsync<unknown>([
      () =>
        v1("POST", "/projects/across/items", {
          items: [seenItem, unseenItem],
        }),
      () =>
        v1("PATCH", "/projects/across", {
          goal: "go",
          targetDate: "2027-01-01",
        }),
      () => seed.statusUpdate({ project: "across" }, "project news"),
      () => seed.statusUpdate({ product: seen.key }, "product news"),
      () => seed.statusUpdate({ project: "unseen-only" }, "secret news"),
      () => v1("DELETE", `/projects/across/items/${seenItem}`),
    ]);
  });

  const feed = async (query = "") => {
    const res = await request("GET", `/api/web/feed${query}`, {
      key: null,
      cookie,
    });
    return {
      status: res.status,
      text: await res.clone().text(),
      body: (await res.json()) as Body,
    };
  };

  test("shows a visible project's own events with no product, item events with type and product, and nothing of a hidden product", async () => {
    const { body, text } = await feed();
    expect(
      body.items.map((e: Body) => [
        e.kind,
        e.product?.key ?? null,
        e.project?.slug ?? null,
        e.item?.type ?? null,
      ]),
    ).toEqual([
      ["removed_from_project", seen.key, "across", "todo"],
      ["product_status_update", seen.key, null, null],
      ["project_status_update", null, "across", null],
      ["project_updated", null, "across", null],
      ["added_to_project", seen.key, "across", "todo"],
      ["project_created", null, "across", null],
      ["item_created", seen.key, null, "todo"],
    ]);
    expect(body.items[3].changed).toEqual(["goal", "targetDate"]);
    expect(body.items[2].statusUpdate).toMatchObject({ body: "project news" });
    expect(text).not.toContain(unseen.key);
    expect(text).not.toContain("Unseen");
    expect(text).not.toContain("secret news");
  });

  test("offers the visible projects as a filter", async () => {
    const { body } = await feed();
    expect(body.filters.projects).toEqual([{ slug: "across", name: "Across" }]);
  });

  test("filters by project: its own events and its items coming and going", async () => {
    const { body } = await feed("?project=across");
    expect(body.items.map((e: Body) => e.kind)).toEqual([
      "removed_from_project",
      "project_status_update",
      "project_updated",
      "added_to_project",
      "project_created",
    ]);
  });

  test("filters by product: no project's own event", async () => {
    const { body } = await feed(`?product=${seen.key}`);
    expect(body.items.map((e: Body) => e.kind)).toEqual([
      "removed_from_project",
      "product_status_update",
      "added_to_project",
      "item_created",
    ]);
  });

  test("a project with none of the viewer's products is the same 404 as an unknown one", async () => {
    const hidden = await feed("?project=unseen-only");
    const unknown = await feed("?project=nope");
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.body.error.message).toBe("no project unseen-only");
  });

  test("a cursor goes back only with the project it was issued under", async () => {
    const { body } = await feed("?limit=1&project=across");
    const res = await feed(`?limit=1&cursor=${body.nextCursor}`);
    expect(res.status).toBe(422);
    const ok = await feed(`?limit=1&project=across&cursor=${body.nextCursor}`);
    expect(ok.body.items.map((e: Body) => e.kind)).toEqual([
      "project_status_update",
    ]);
  });
});
