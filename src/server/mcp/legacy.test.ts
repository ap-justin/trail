import { expect, test } from "vitest";
import { project, projectProduct } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";
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
  const other = await connect(createBot(db, "legacy filer").key);
  // one stamp apiece: same-millisecond rows would list in random id order
  const [own, filed] = await atFakeTimeAsync([
    () =>
      call(owner, "create_issue", {
        projectId: "lgi",
        title: "mine",
      }),
    () =>
      call(other, "create_issue", {
        projectId: "LGI",
        title: "theirs",
      }),
  ]);
  if (!own || !filed) throw new Error("create_issue answered nothing");
  expect(own).toMatchObject({
    type: "todo",
    status: "open",
    assigneeId: bot.actor.id,
    deprecated: expect.stringMatching(
      /^create_issue and POST \/issues are deprecated: use add_todo/,
    ),
  });
  // the old status enum has no triage: an issue waiting there reads as open
  expect(filed).toMatchObject({ type: "issue", status: "open" });
  expect(await call(owner, "get_item", { item: filed.key })).toMatchObject({
    status: "triage",
  });

  expect(await call(owner, "get_issue", { issueId: filed.key })).toMatchObject({
    key: filed.key,
    status: "open",
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
  const listed = (await call(client, "list_projects", { limit: 200 }))
    .items as Body[];
  expect(listed.map((p) => p.slug)).toContain("new-style");
  // every row is a project (a slug, no product key), never the product LGP
  expect(listed.every((p) => typeof p.slug === "string" && !("key" in p))).toBe(
    true,
  );
});

test("get_project and update_project take a slug first, else a product key by the old meaning with a deprecated note", async () => {
  const client = await connect(bot.key);
  const lgu = await call(client, "create_product", {
    key: "LGU",
    name: "fallback",
  });
  expect(
    await callError(client, "create_project", {
      name: "lgu",
      slug: "lgu",
      products: ["LGU"],
    }),
  ).toBe(
    "conflict: slug lgu is the key of product LGU, and a project's slug never matches a product's key: pick another slug, or leave slug out to derive a free one from the name",
  );
  // a slug equal to a product key, as data from before the rule may hold
  const older = db
    .insert(project)
    .values({
      slug: "lgu",
      name: "older",
      leadId: bot.actor.id,
      createdBy: bot.actor.id,
    })
    .returning()
    .get();
  db.insert(projectProduct)
    .values({ projectId: older.id, productId: lgu.id })
    .run();
  expect(await call(client, "get_project", { project: "lgu" })).toMatchObject({
    slug: "lgu",
    name: "older",
  });
  expect(
    await call(client, "update_project", { project: "lgu", name: "x" }),
  ).toMatchObject({ slug: "lgu", name: "x" });
  expect(
    await call(client, "post_status_update", {
      project: "lgu",
      body: "on the project",
      health: "on_track",
    }),
  ).toMatchObject({ project: "lgu", product: null });
  expect(
    (await call(client, "list_status_updates", { project: "lgu" })).items.map(
      (u: Body) => u.body,
    ),
  ).toEqual(["on the project"]);
  const product = await call(client, "get_project", { project: "LGU" });
  expect(product).toMatchObject({
    key: "LGU",
    deprecated: expect.stringMatching(/use get_product/),
  });
  await call(client, "create_project", {
    name: "lgu plan",
    slug: "lgu-plan",
    products: ["LGU"],
  });
  expect(
    await call(client, "get_project", { projectId: "lgu-plan" }),
  ).toMatchObject({
    slug: "lgu-plan",
    deprecated: "projectId is deprecated: send project instead",
  });
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
      project: "lgu-plan",
      description: "d",
    }),
  ).toBe(
    "validation_failed: lgu-plan is a project, which has a goal, not a description: send goal instead",
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

test("list_issues with status open includes issues waiting in triage, as open meant before triage; list_items keeps exact status", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "LGS", name: "legacy status" });
  const filer = await connect(createBot(db, "lgs filer").key);
  // one stamp apiece: same-millisecond rows would list in random id order
  const [filed, todo, started] = (await atFakeTimeAsync([
    () => call(filer, "file_issue", { product: "LGS", title: "filed" }),
    () => call(owner, "add_todo", { product: "LGS", title: "planned" }),
    () => call(owner, "add_todo", { product: "LGS", title: "started" }),
  ])) as Body[];
  if (!filed || !todo || !started) throw new Error("a create answered nothing");
  await call(owner, "update_item", {
    item: started.key,
    status: "in_progress",
  });
  const keys = async (tool: string, args: Body) =>
    (await call(owner, tool, args)).items.map((i: Body) => i.key);

  expect(
    await keys("list_issues", { projectId: "LGS", status: "open" }),
  ).toEqual([todo.key, filed.key]);
  const legacy = await call(owner, "list_issues", { projectId: "LGS" });
  expect(legacy.items.map((i: Body) => i.status)).toEqual([
    "in_progress",
    "open",
    "open",
  ]);
  expect(
    await keys("list_issues", { projectId: "LGS", status: "in_progress" }),
  ).toEqual([started.key]);
  expect(await keys("list_items", { product: "LGS", status: "open" })).toEqual([
    todo.key,
  ]);
});

test("list_projects carries deprecated, pointing a caller after products to list_products", async () => {
  const client = await connect(bot.key);
  const made = await call(client, "create_project", {
    name: "listed",
    products: ["LGS"],
  });
  const page = await call(client, "list_projects", {});
  expect(page.items.map((p: Body) => p.slug)).toContain(made.slug);
  expect(page.deprecated).toBe(
    "list_projects now lists projects (groups of items across products), not products: call list_products (GET /products) for those",
  );
});

test("update_issue can't unassign a todo, and says to reassign it instead", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "LGT", name: "legacy todo" });
  const todo = await call(owner, "add_todo", { product: "LGT", title: "kept" });
  expect(
    await callError(owner, "update_issue", {
      issueId: todo.key,
      assigneeId: null,
    }),
  ).toBe(
    `validation_failed: ${todo.key} is a todo, and a todo always has an assignee, so it can't be unassigned: reassign it by sending assigneeId with another bot's name or id (list_bots lists them)`,
  );
  createBot(db, "lgt helper");
  expect(
    await call(owner, "update_issue", {
      issueId: todo.key,
      assigneeId: "lgt helper",
    }),
  ).toMatchObject({ assignee: { name: "lgt helper" } });
});

test("update_issue keeps the owner rule: an outsider can't accept, cancel or retype a triage issue, nor reopen one the filer canceled", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "LGO", name: "legacy owner" });
  const filer = await connect(createBot(db, "legacy owner filer").key);
  const outsider = await connect(createBot(db, "legacy outsider").key);
  const filed = await call(filer, "create_issue", {
    projectId: "LGO",
    title: "owner decides",
  });
  for (const status of ["open", "canceled"]) {
    expect(
      await callError(outsider, "update_issue", {
        issueId: filed.key,
        status,
      }),
      status,
    ).toBe(
      `forbidden: ${filed.key} is in the triage of LGO, which tester owns: only tester accepts or cancels it, and its filer may cancel it. Comment on it with add_comment to ask tester`,
    );
  }
  expect(
    await callError(outsider, "update_issue", {
      issueId: filed.key,
      type: "todo",
    }),
  ).toContain('Unrecognized key "type"');
  await call(filer, "update_issue", { issueId: filed.key, status: "canceled" });
  expect(
    await callError(filer, "update_issue", {
      issueId: filed.key,
      status: "open",
    }),
  ).toBe(
    `forbidden: ${filed.key} was filed on LGO, which tester owns, and was canceled: only tester reopens it. Comment on it with add_comment to ask tester`,
  );
  expect(await call(owner, "get_item", { item: filed.key })).toMatchObject({
    type: "issue",
    status: "canceled",
  });
  expect(
    await call(outsider, "update_issue", {
      issueId: filed.key,
      labels: ["outside-made"],
    }),
  ).toMatchObject({ labels: [], skippedLabels: ["outside-made"] });
});

test("update_issue cancels an accepted issue or a todo only for the owner or the filer", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "LGC", name: "legacy cancel" });
  const filer = await connect(createBot(db, "legacy cancel filer").key);
  const outsider = await connect(createBot(db, "legacy cancel outsider").key);
  const issue = await call(filer, "create_issue", {
    projectId: "LGC",
    title: "accepted then dropped",
  });
  await call(owner, "update_issue", {
    issueId: issue.key,
    status: "open",
    assigneeId: "tester",
  });
  const todo = await call(owner, "create_issue", {
    projectId: "LGC",
    title: "owner's own",
  });
  expect(todo.type).toBe("todo");
  for (const { key } of [issue, todo]) {
    expect(
      await callError(outsider, "update_issue", {
        issueId: key,
        status: "canceled",
      }),
      key,
    ).toBe(
      `forbidden: ${key} is on LGC, which tester owns: only tester or the bot that filed it cancels it. Comment on it with add_comment to ask tester`,
    );
  }
  expect(
    await call(filer, "update_issue", {
      issueId: issue.key,
      status: "canceled",
    }),
  ).toMatchObject({ status: "canceled" });
});

test("an argument sent under its old name is refused naming the argument it became", async () => {
  const client = await connect(bot.key);
  expect(
    await callError(client, "add_todo", { projectId: "LGT", title: "old" }),
  ).toContain(
    'Unrecognized key "projectId": it is product now, so send product instead',
  );
  expect(
    await callError(client, "update_item", {
      item: "LGT-1",
      assigneeId: "tester",
    }),
  ).toContain(
    'Unrecognized key "assigneeId": it is assignee now, so send assignee instead',
  );
});

test("create_issue and list_issues take project or product as aliases of projectId, refusing two spellings with different values", async () => {
  const client = await connect(bot.key);
  await call(client, "create_product", { key: "LGZ", name: "legacy aliases" });
  const viaProject = await call(client, "create_issue", {
    project: "LGZ",
    title: "via project",
  });
  const viaProduct = await call(client, "create_issue", {
    product: "lgz",
    title: "via product",
  });
  expect([viaProject.key, viaProduct.key]).toEqual(["LGZ-1", "LGZ-2"]);
  for (const name of ["projectId", "project", "product"]) {
    const listed = await call(client, "list_issues", { [name]: "LGZ" });
    expect(listed.items.map((i: Body) => i.key).sort(), name).toEqual([
      "LGZ-1",
      "LGZ-2",
    ]);
  }
  const same = await call(client, "create_issue", {
    projectId: "LGZ",
    product: "LGZ",
    title: "both",
  });
  expect(same.key).toBe("LGZ-3");
  expect(
    (await call(client, "list_issues", { project: "LGZ", product: "LGZ" }))
      .items,
  ).toHaveLength(3);
  for (const [tool, args] of [
    ["create_issue", { projectId: "LGZ", product: "OTHER", title: "both" }],
    ["list_issues", { project: "LGZ", product: "OTHER" }],
  ] as const) {
    expect(await callError(client, tool, args), tool).toBe(
      "validation_failed: send one of projectId, project or product: they name the same product, and two different values are ambiguous",
    );
  }
  expect(await callError(client, "create_issue", { title: "nowhere" })).toBe(
    "validation_failed: projectId is required: send the product's key, like TRL (project or product are its aliases); list_products lists them",
  );
});

test("a retry of create_issue returns the first item whoever owns the product, never a 500", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "RTY", name: "retried" });
  const other = await connect(createBot(db, "retrying filer").key);
  for (const [client, key, skippedLabels] of [
    [owner, "retry-owner", undefined],
    [other, "retry-other", ["missing retry-other"]],
  ] as const) {
    const input = {
      projectId: "RTY",
      title: key,
      // a label of its own per caller: the owner creates its label, which would stop the other caller skipping a shared one
      labels: [`missing ${key}`],
      externalRef: key,
      idempotency_key: key,
    };
    const first = await call(client, "create_issue", input);
    expect(first.skippedLabels).toEqual(skippedLabels);
    expect(await call(client, "create_issue", input)).toEqual(first);
    const listed = await call(client, "list_items", { product: "RTY" });
    expect(
      listed.items.filter((i: { title: string }) => i.title === key),
    ).toHaveLength(1);
  }
});

test("create_issue refuses an idempotency key reused with a changed body and creates nothing", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "RKR", name: "reused key" });
  const input = { projectId: "RKR", title: "once", idempotency_key: "reuse-1" };
  await call(owner, "create_issue", input);
  expect(
    await callError(owner, "create_issue", { ...input, title: "changed" }),
  ).toMatch(
    /^idempotency_key_reused: idempotency key "reuse-1" was already used for a different request body or target/,
  );
  const listed = await call(owner, "list_items", { product: "RKR" });
  expect(listed.items).toHaveLength(1);
});

test("a retry of create_issue with no idempotency key and an externalRef is a conflict naming the item", async () => {
  const owner = await connect(bot.key);
  await call(owner, "create_product", { key: "RTZ", name: "retried too" });
  const input = { projectId: "RTZ", title: "once", externalRef: "ext-1" };
  const first = await call(owner, "create_issue", input);
  expect(await callError(owner, "create_issue", input)).toBe(
    `conflict: externalRef ext-1 is already on item ${first.key}: update that item with update_item (PATCH /items/{key}), or send a different externalRef`,
  );
});
