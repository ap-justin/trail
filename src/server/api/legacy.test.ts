import { beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

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
  expect(item).toMatchObject({
    type: "issue",
    status: "triage",
    product: "LEG",
    deprecated: expect.stringMatching(/use add_todo/),
  });
  const read = await json(await request("GET", `/api/v1/issues/${item.key}`));
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

test("a slug wins over the legacy meaning and its answers carry no deprecated note", async () => {
  const created = await request("POST", "/api/v1/projects", {
    json: { name: "leg", slug: "leg", products: ["LEG"] },
  });
  expect(created.status).toBe(201);
  const project = await json(created);
  expect(project).not.toHaveProperty("deprecated");
  const got = await json(await request("GET", "/api/v1/projects/leg"));
  expect(got).toEqual(project);
  const posted = await json(
    await request("POST", "/api/v1/projects/leg/status-updates", {
      json: { body: "project update", health: "at_risk" },
    }),
  );
  expect(posted).toMatchObject({ project: "leg", product: null });
  expect(posted).not.toHaveProperty("deprecated");
  // the upper-case key still reaches the product: slugs are lowercase only
  expect(
    await json(await request("GET", "/api/v1/projects/LEG")),
  ).toMatchObject({
    key: "LEG",
  });
});

test("GET /projects lists projects, never products", async () => {
  const page = await json(await request("GET", "/api/v1/projects?limit=200"));
  expect(page.items.every((p: Body) => typeof p.slug === "string")).toBe(true);
  expect(page.items.some((p: Body) => "key" in p)).toBe(false);
});
