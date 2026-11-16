import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

test("each deprecated alias says so first and names its replacement", async () => {
  const { tools } = await (await connect(bot.key)).listTools();
  const describe = (name: string) =>
    tools.find((t) => t.name === name)?.description ?? "";
  for (const [alias, replacement] of [
    ["create_issue", "add_todo or file_issue"],
    ["get_issue", "get_item"],
    ["update_issue", "update_item"],
    ["list_issues", "list_items"],
  ] as const) {
    expect(describe(alias)).toMatch(
      new RegExp(
        `^DEPRECATED alias of ${replacement} \\(removed after the next release\\)`,
      ),
    );
  }
  expect(describe("list_projects")).toMatch(
    /Before this release list_projects listed products; call list_products for those/,
  );
});

test("create_issue makes a todo for the product's owner and an issue in triage for anyone else, each carrying deprecated", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "LGI", name: "legacy items" });
  const own = await call(owner, "create_issue", {
    projectId: "lgi",
    title: "mine",
  });
  expect(own).toMatchObject({
    type: "todo",
    status: "open",
    assigneeId: bot.actor.id,
    deprecated: expect.stringMatching(
      /^create_issue and POST \/issues are deprecated: use add_todo/,
    ),
  });
  const other = await connect(createBot(db, "legacy filer").key);
  const filed = await call(other, "create_issue", {
    projectId: "LGI",
    title: "theirs",
  });
  expect(filed).toMatchObject({ type: "issue", status: "triage" });

  expect(await call(owner, "get_issue", { issueId: filed.key })).toMatchObject({
    key: filed.key,
    deprecated:
      "get_issue and GET /issues/{id} are deprecated: use get_item (GET /items/{key})",
  });
  expect(
    await call(owner, "update_issue", {
      issueId: filed.key,
      status: "open",
      assigneeId: "legacy filer",
    }),
  ).toMatchObject({
    status: "open",
    assignee: { name: "legacy filer" },
    deprecated: expect.stringMatching(/use update_item/),
  });
  const listed = await call(owner, "list_issues", { projectId: "LGI" });
  expect(listed.items.map((i: Body) => i.key)).toEqual([filed.key, own.key]);
  expect(listed.deprecated).toMatch(/use list_items/);
});

test("create_project with key creates a product and says so; with project fields it creates a project", async () => {
  const client = await connect(bot.key);
  const product = await call(client, "create_project", {
    key: "LGP",
    name: "legacy product",
    description: "old style",
  });
  expect(product).toMatchObject({
    key: "LGP",
    description: "old style",
    owner: { id: bot.actor.id },
    deprecated:
      "create_project with key (POST /projects with key) is deprecated: use create_product (POST /products) to create a product",
  });
  const project = await call(client, "create_project", {
    name: "New style",
    products: ["LGP"],
  });
  expect(project).toMatchObject({ slug: "new-style" });
  expect(project).not.toHaveProperty("deprecated");
  expect(
    await callError(client, "create_project", {
      key: "LGQ",
      name: "mixed",
      products: ["LGP"],
    }),
  ).toBe(
    "validation_failed: key creates a product (deprecated), and products create a project: drop key to create a project, or use create_product (POST /products) for a product",
  );
  expect(
    (await call(client, "list_projects", { limit: 200 })).items.map(
      (p: Body) => p.slug ?? p.key,
    ),
  ).toEqual(["new-style"]);
});

test("get_project and update_project take a slug first, else a product key by the old meaning with a deprecated note", async () => {
  const client = await connect(bot.key);
  await call(client, "create_product", { key: "LGU", name: "fallback" });
  const project = await call(client, "create_project", {
    name: "lgu",
    slug: "lgu",
    products: ["LGU"],
  });
  expect(await call(client, "get_project", { project: "lgu" })).toEqual(
    project,
  );
  const product = await call(client, "get_project", { project: "LGU" });
  expect(product).toMatchObject({
    key: "LGU",
    deprecated: expect.stringMatching(/use get_product/),
  });
  expect(await call(client, "get_project", { projectId: "lgu" })).toMatchObject(
    {
      slug: "lgu",
      deprecated: "projectId is deprecated: send project instead",
    },
  );
  expect(
    await call(client, "update_project", {
      project: "LGU",
      description: "via the old tool",
    }),
  ).toMatchObject({
    key: "LGU",
    description: "via the old tool",
    deprecated: expect.any(String),
  });
  expect(
    await callError(client, "update_project", { project: "LGU", goal: "g" }),
  ).toBe(
    "validation_failed: LGU is a product, which has no goal: change a product with update_product (PATCH /products/{key}), or name a project by its slug",
  );
  expect(
    await callError(client, "update_project", {
      project: "lgu",
      description: "d",
    }),
  ).toBe(
    "validation_failed: lgu is a project, which has a goal, not a description: send goal instead",
  );
});

test("the old projectId and issueId arguments still work and carry a deprecated note", async () => {
  const client = await connect(bot.key);
  await call(client, "create_product", { key: "LGA", name: "args" });
  const todo = await call(client, "add_todo", { product: "LGA", title: "t" });
  const comment = await call(client, "add_comment", {
    issueId: todo.key,
    body: "old arg",
  });
  expect(comment.deprecated).toBe("issueId is deprecated: send item instead");
  const label = await call(client, "create_label", {
    projectId: "LGA",
    name: "Old",
  });
  expect(label.deprecated).toBe(
    "projectId is deprecated: send product instead",
  );
  const update = await call(client, "post_status_update", {
    projectId: "LGA",
    body: "old",
    health: "on_track",
  });
  expect(update).toMatchObject({
    product: "LGA",
    deprecated: expect.any(String),
  });
  expect(
    await callError(client, "list_labels", {
      product: "LGA",
      projectId: "LGA",
    }),
  ).toBe(
    "validation_failed: send product alone: projectId is its deprecated alias, and both together is ambiguous",
  );
});
