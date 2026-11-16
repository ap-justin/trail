import { beforeAll, expect, test } from "vitest";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { bot, addBot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const json = async (res: Response) => (await res.json()) as Body;

let product: Body;
beforeAll(async () => {
  product = await json(
    await request("POST", "/api/v1/projects", {
      json: { key: "LEG", name: "legacy" },
    }),
  );
});

test("POST /projects with key creates a product, carrying deprecated", async () => {
  expect(product).toMatchObject({
    key: "LEG",
    owner: { id: bot.actor.id },
    deprecated: expect.stringMatching(/use create_product \(POST \/products\)/),
  });
});

test("the /issues routes serve items, each answer carrying deprecated", async () => {
  const filer = addBot("legacy rest filer");
  const created = await request("POST", "/api/v1/issues", {
    json: { projectId: "leg", title: "old route" },
    key: filer.key,
  });
  expect(created.status).toBe(201);
  const item = await json(created);
  // the old status enum has no triage: an issue waiting there reads as open
  expect(item).toMatchObject({
    type: "issue",
    status: "open",
    product: "LEG",
    deprecated: expect.stringMatching(/use add_todo/),
  });
  const read = await json(await request("GET", `/api/v1/issues/${item.key}`));
  expect(read.status).toBe("open");
  expect(
    (await json(await request("GET", `/api/v1/items/${item.key}`))).status,
  ).toBe("triage");
  expect(read.deprecated).toMatch(/use get_item \(GET \/items\/\{key\}\)/);
  const patched = await json(
    await request("PATCH", `/api/v1/issues/${item.key}`, {
      json: { status: "open", assigneeId: "tester" },
    }),
  );
  expect(patched).toMatchObject({
    status: "open",
    assigneeId: bot.actor.id,
    deprecated: expect.stringMatching(/use update_item/),
  });
  const page = await json(await request("GET", "/api/v1/issues?projectId=LEG"));
  expect(page.items.map((i: Body) => i.key)).toEqual([item.key]);
  const another = await json(
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LEG", title: "still in triage" },
      key: filer.key,
    }),
  );
  const listed = await json(
    await request("GET", "/api/v1/issues?projectId=LEG"),
  );
  expect(listed.items.find((i: Body) => i.key === another.key)?.status).toBe(
    "open",
  );
  expect(page.deprecated).toMatch(/use list_items \(GET \/items\)/);
  const comment = await json(
    await request("POST", `/api/v1/issues/${item.key}/comments`, {
      json: { body: "old comment" },
    }),
  );
  expect(comment.deprecated).toMatch(/use \/items\/\{key\}\/comments/);
  const thread = await json(
    await request("GET", `/api/v1/issues/${item.key}/comments`),
  );
  expect(thread).toMatchObject({
    items: [{ body: "old comment" }],
    deprecated: expect.any(String),
  });
});

test("/projects/{KEY} that matches no slug names the product, carrying deprecated", async () => {
  const got = await json(await request("GET", "/api/v1/projects/leg"));
  expect(got).toMatchObject({
    key: "LEG",
    deprecated: expect.stringMatching(/use get_product/),
  });
  const patched = await json(
    await request("PATCH", "/api/v1/projects/LEG", {
      json: { description: "patched the old way" },
    }),
  );
  expect(patched).toMatchObject({
    description: "patched the old way",
    deprecated: expect.any(String),
  });
  const posted = await request("POST", "/api/v1/projects/LEG/status-updates", {
    json: { body: "old update", health: "on_track" },
  });
  expect(posted.status).toBe(201);
  expect(await json(posted)).toMatchObject({
    product: "LEG",
    deprecated: expect.any(String),
  });
  const updates = await json(
    await request("GET", "/api/v1/projects/LEG/status-updates"),
  );
  expect(updates).toMatchObject({
    items: [{ body: "old update" }],
    deprecated: expect.any(String),
  });
  const label = await json(
    await request("POST", "/api/v1/projects/LEG/labels", {
      json: { name: "Old" },
    }),
  );
  expect(label).toMatchObject({
    name: "Old",
    deprecated:
      "/projects/{key}/labels is deprecated: use /products/{key}/labels",
  });
  expect(
    (await json(await request("GET", "/api/v1/projects/LEG/labels"))).items,
  ).toHaveLength(1);
});

test("a ref naming both a project's slug and a product's key is a 422 naming both, on every /projects/{ref} route", async () => {
  const created = await request("POST", "/api/v1/projects", {
    json: { name: "leg", slug: "leg", products: ["LEG"] },
  });
  expect(created.status).toBe(201);
  const refusal =
    "leg names both project leg and product LEG, so it is refused rather than guessed: use get_product or update_product (/products/LEG) for the product; list_projects (GET /projects) lists the project, and list_products (GET /products) the products";
  for (const [method, path, body] of [
    ["GET", "/api/v1/projects/leg", undefined],
    ["PATCH", "/api/v1/projects/leg", { name: "renamed" }],
    ["GET", "/api/v1/projects/leg/status-updates", undefined],
    [
      "POST",
      "/api/v1/projects/leg/status-updates",
      { body: "which one", health: "at_risk" },
    ],
  ] as const) {
    const res = await request(method, path, body ? { json: body } : {});
    expect(res.status, `${method} ${path}`).toBe(422);
    expect((await json(res)).error.message).toBe(refusal);
  }
  // the upper-case key still reaches the product: slugs are lowercase only
  expect(
    await json(await request("GET", "/api/v1/projects/LEG")),
  ).toMatchObject({ key: "LEG", name: "legacy" });
});

test("a slug no product key matches names the project, its answers carrying no deprecated note", async () => {
  const project = await json(
    await request("POST", "/api/v1/projects", {
      json: { name: "leg plan", slug: "leg-plan", products: ["LEG"] },
    }),
  );
  expect(project).not.toHaveProperty("deprecated");
  expect(await json(await request("GET", "/api/v1/projects/leg-plan"))).toEqual(
    project,
  );
  const posted = await json(
    await request("POST", "/api/v1/projects/leg-plan/status-updates", {
      json: { body: "project update", health: "at_risk" },
    }),
  );
  expect(posted).toMatchObject({ project: "leg-plan", product: null });
  expect(posted).not.toHaveProperty("deprecated");
});

test("GET /projects lists projects, never products", async () => {
  await request("POST", "/api/v1/products", {
    json: { key: "LGL", name: "legacy list" },
  });
  const made = await request("POST", "/api/v1/projects", {
    json: { name: "lgl list", slug: "lgl-list", products: ["LGL"] },
  });
  expect(made.status).toBe(201);
  const page = await json(await request("GET", "/api/v1/projects?limit=200"));
  // the list is live: it holds the project this test just made
  expect(page.items.map((p: Body) => p.slug)).toContain("lgl-list");
  expect(page.items.every((p: Body) => typeof p.slug === "string")).toBe(true);
  expect(page.items.some((p: Body) => "key" in p)).toBe(false);
  expect(page.deprecated).toBe(
    "list_projects lists projects (groups of items across products) since this release, no longer products: call list_products (GET /products) for those",
  );
});

test("GET /issues?status=open includes issues waiting in triage, as open meant before triage; GET /items keeps exact status", async () => {
  await request("POST", "/api/v1/products", {
    json: { key: "LGO", name: "legacy open" },
  });
  const create = async (title: string, key = bot.key) =>
    json(
      await request("POST", "/api/v1/issues", {
        json: { projectId: "LGO", title },
        key,
      }),
    );
  const filer = addBot("lgo filer").key;
  // one stamp apiece: same-millisecond rows would list in random id order
  const [filed, todo, started] = (await atFakeTimeAsync([
    () => create("filed by another bot", filer),
    () => create("planned"),
    () => create("started"),
  ])) as Body[];
  if (!filed || !todo || !started) throw new Error("a create answered nothing");
  await request("PATCH", `/api/v1/items/${started.key}`, {
    json: { status: "in_progress" },
  });
  expect([filed.type, todo.type]).toEqual(["issue", "todo"]);
  const keys = async (path: string) =>
    (await json(await request("GET", path))).items.map((i: Body) => i.key);

  expect(await keys("/api/v1/issues?projectId=LGO&status=open")).toEqual([
    todo.key,
    filed.key,
  ]);
  expect(await keys("/api/v1/issues?projectId=LGO&status=in_progress")).toEqual(
    [started.key],
  );
  expect(await keys("/api/v1/items?product=LGO&status=open")).toEqual([
    todo.key,
  ]);
});
