import { beforeAll, describe, expect, test } from "vitest";
import { atFakeTime, atFakeTimeAsync, setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { request, signIn, owner, addMember, addProject, addBot } =
  setupTestApp();
const { get, item, project, statusUpdate } = webSeed(request);

test("GET /products lists only the member's products, with open issues (triage and open), open todos and project counts", async () => {
  const mine = addProject("Mine");
  const theirs = addProject("Theirs");
  await item(mine.key, "issue");
  await item(mine.key, "issue", { status: "open" });
  await item(mine.key, "issue", { status: "in_progress" });
  const todo = await item(mine.key, "todo");
  await item(mine.key, "todo", { status: "done" });
  await item(theirs.key, "issue");
  await project("Shared", [mine.key, theirs.key]);
  await project("Hidden", [theirs.key]);
  void todo;
  const cookie = await addMember("pat", [mine.id]);

  const { status, body } = await get("/products", cookie);

  expect(status).toBe(200);
  expect(body.items).toEqual([
    {
      key: mine.key,
      name: "Mine",
      description: "",
      repoUrl: null,
      health: null,
      latestStatusUpdate: null,
      openIssues: 2,
      openTodos: 1,
      projectCount: 1,
      updatedAt: expect.any(String),
    },
  ]);
});

test("a product carries its repo URL, and its health and latest status update are its newest update's", async () => {
  const p = addProject("Health");
  const reporter = addBot("reporter");
  await request("PATCH", `/api/v1/products/${p.key}`, {
    json: { repoUrl: "https://github.com/acme/health" },
  });
  await atFakeTimeAsync([
    () => statusUpdate({ product: p.key }, "fine"),
    () => statusUpdate({ product: p.key }, "slipping", "at_risk", reporter.key),
  ]);
  const { body } = await get("/products", await signIn(owner));
  expect(body.items.find((r: Body) => r.key === p.key)).toMatchObject({
    repoUrl: "https://github.com/acme/health",
    health: "at_risk",
    latestStatusUpdate: {
      body: "slipping",
      health: "at_risk",
      author: {
        id: reporter.actor.id,
        name: "reporter",
        kind: "bot",
        photoUrl: null,
        title: null,
      },
      sourceAuthor: null,
    },
  });
});

test("a product's updatedAt is its newest item update when that is later than the product's own", async () => {
  const [p] = atFakeTime([() => addProject("Fresh")]);
  if (!p) throw new Error("no product");
  const key = await item(p.key, "issue");
  const { body: created } = await get(`/items/${key}`, await signIn(owner));
  const { body } = await get(`/products/${p.key}`, await signIn(owner));
  expect(body.updatedAt).toBe(created.updatedAt);
});

describe("GET /products/:key", () => {
  let p: { id: string; key: string };
  let hidden: { id: string; key: string };
  let lead: ReturnType<typeof addBot>;
  let cookie = "";
  beforeAll(async () => {
    p = addProject("Page");
    hidden = addProject("Elsewhere");
    lead = addBot("leader");
    await request("PATCH", `/api/v1/products/${p.key}`, {
      json: { owner: lead.actor.id },
    });
    await atFakeTimeAsync([
      () => project("Older", [p.key], [], { lead: "leader" }),
      () =>
        project("Newer", [p.key, hidden.key], [], {
          lead: "leader",
          targetDate: "2026-12-01",
        }),
      () => project("Not here", [hidden.key]),
    ]);
    cookie = await addMember("pager", [p.id]);
  });

  test("takes the key in any case, and serves its owner and its projects newest first", async () => {
    const { status, body } = await get(
      `/products/${p.key.toLowerCase()}`,
      cookie,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      key: p.key,
      owner: { name: "leader", kind: "bot" },
      projectCount: 2,
    });
    expect(body.projects).toEqual([
      {
        slug: "newer",
        name: "Newer",
        goal: "",
        health: null,
        latestStatusUpdate: null,
        lead: expect.objectContaining({ name: "leader", kind: "bot" }),
        targetDate: "2026-12-01",
        products: [{ key: p.key, name: "Page" }],
        openCount: 0,
        updatedAt: expect.any(String),
      },
      expect.objectContaining({ slug: "older", targetDate: null }),
    ]);
  });

  test("never names a product the viewer can't see", async () => {
    const res = await request("GET", `/api/web/products/${p.key}`, {
      key: null,
      cookie,
    });
    const text = await res.text();
    expect(text).toContain(p.key);
    expect(text).not.toContain(hidden.key);
    expect(text).not.toContain("Elsewhere");
  });

  test("a product the member can't see is the same 404 as one that doesn't exist", async () => {
    const hiddenRes = await get(`/products/${hidden.key}`, cookie);
    const missing = await get("/products/NOPE", cookie);
    expect(hiddenRes.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hiddenRes.body.error.message).toBe(
      missing.body.error.message.replace("NOPE", hidden.key),
    );
  });
});

test("GET /products/:key/status-updates pages newest first", async () => {
  const p = addProject("Updates");
  await atFakeTimeAsync(
    ["one", "two", "three"].map(
      (body) => () => statusUpdate({ product: p.key }, body),
    ),
  );
  const cookie = await signIn(owner);
  const first = await get(`/products/${p.key}/status-updates?limit=2`, cookie);
  expect(first.body.items.map((u: Body) => u.body)).toEqual(["three", "two"]);
  const rest = await get(
    `/products/${p.key}/status-updates?limit=2&cursor=${first.body.nextCursor}`,
    cookie,
  );
  expect(rest.body).toMatchObject({
    items: [{ body: "one" }],
    nextCursor: null,
  });
});

describe("GET /products/:key/items", () => {
  let p: { id: string; key: string };
  let cookie = "";
  let keys: Record<string, string> = {};
  beforeAll(async () => {
    p = addProject("List");
    const other = addProject("Other");
    const assignee = addBot("assignee");
    const steps = await atFakeTimeAsync([
      () => item(p.key, "issue"),
      () => item(p.key, "issue", { status: "open" }),
      () => item(p.key, "issue", { status: "done" }),
      () => item(p.key, "todo", { status: "in_progress" }),
      () =>
        item(p.key, "todo", {
          priority: 2,
          labels: ["b", "a"],
          assignee: assignee.actor.id,
        }),
      () => item(other.key, "issue"),
    ]);
    const [triage, open, done, working, labelled] = steps;
    keys = {
      triage: triage as string,
      open: open as string,
      done: done as string,
      working: working as string,
      labelled: labelled as string,
    };
    cookie = await addMember("lister", [p.id]);
  });

  test("lists the product's items newest first as display rows, each with its type and real status", async () => {
    const { status, body } = await get(`/products/${p.key}/items`, cookie);
    expect(status).toBe(200);
    expect(body.items.map((i: Body) => [i.key, i.type, i.status])).toEqual([
      [keys.labelled, "todo", "open"],
      [keys.working, "todo", "in_progress"],
      [keys.done, "issue", "done"],
      [keys.open, "issue", "open"],
      [keys.triage, "issue", "triage"],
    ]);
    expect(body.items[0]).toEqual({
      key: keys.labelled,
      type: "todo",
      title: `todo ${p.key}`,
      status: "open",
      priority: 2,
      labels: ["a", "b"],
      assignee: {
        id: expect.any(String),
        name: "assignee",
        kind: "bot",
        photoUrl: null,
        title: null,
      },
      updatedAt: expect.any(String),
    });
    expect(body.items[4]).toMatchObject({ assignee: null });
    expect(body.nextCursor).toBeNull();
  });

  test("counts per type and status tab, triage folded into open", async () => {
    const { body } = await get(`/products/${p.key}/items`, cookie);
    expect(body.counts).toEqual({
      all: { all: 5, open: 3, in_progress: 1, done: 1, canceled: 0 },
      issue: { all: 3, open: 2, in_progress: 0, done: 1, canceled: 0 },
      todo: { all: 2, open: 1, in_progress: 1, done: 0, canceled: 0 },
      notes: { current: 0, archived: 0 },
    });
  });

  test("status=open matches triage too, and the counts ignore the filters", async () => {
    const { body } = await get(`/products/${p.key}/items?status=open`, cookie);
    expect(body.items.map((i: Body) => i.key)).toEqual([
      keys.labelled,
      keys.open,
      keys.triage,
    ]);
    expect(body.counts.all.all).toBe(5);
  });

  test("status=triage matches triage alone", async () => {
    const { body } = await get(
      `/products/${p.key}/items?status=triage`,
      cookie,
    );
    expect(body.items.map((i: Body) => i.key)).toEqual([keys.triage]);
  });

  test("type=todo shows no issue rows", async () => {
    const { body } = await get(`/products/${p.key}/items?type=todo`, cookie);
    expect(body.items.map((i: Body) => i.key)).toEqual([
      keys.labelled,
      keys.working,
    ]);
  });

  test("type and status combine", async () => {
    const { body } = await get(
      `/products/${p.key}/items?type=issue&status=open`,
      cookie,
    );
    expect(body.items.map((i: Body) => i.key)).toEqual([
      keys.open,
      keys.triage,
    ]);
  });

  test("pages with limit and cursor", async () => {
    const first = await get(`/products/${p.key}/items?limit=3`, cookie);
    expect(first.body.items).toHaveLength(3);
    const rest = await get(
      `/products/${p.key}/items?limit=3&cursor=${first.body.nextCursor}`,
      cookie,
    );
    expect(rest.body).toMatchObject({
      items: [{ key: keys.open }, { key: keys.triage }],
      nextCursor: null,
    });
  });

  test("an unknown type is a 422", async () => {
    const { status } = await get(`/products/${p.key}/items?type=epic`, cookie);
    expect(status).toBe(422);
  });
});
