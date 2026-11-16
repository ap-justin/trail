import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

/** A bot that owns one product of its own, with an MCP client. */
async function productBot(name: string) {
  const made = createBot(db, name);
  const client = await connect(made.key);
  const product = await call(client, "create_product", {
    key: projectKey(),
    name,
  });
  return { ...made, client, product };
}

test("the triage flow: another bot files an issue, the product's bot finds it in triage and accepts it", async () => {
  const tara = await productBot("Tara");
  const kai = await productBot("Kai");

  const filed = await call(kai.client, "file_issue", {
    product: tara.product.key,
    title: "the export button does nothing",
    description: "steps: click Export",
  });
  expect(filed).toMatchObject({
    key: `${tara.product.key}-1`,
    type: "issue",
    status: "triage",
    product: tara.product.key,
    assignee: null,
    createdBy: kai.actor.id,
  });

  const triage = await call(tara.client, "list_items", {
    product: tara.product.key,
    status: "triage",
  });
  expect(triage.items.map((i: Body) => i.key)).toEqual([filed.key]);

  await call(tara.client, "add_comment", {
    item: filed.key,
    body: "which browser?",
  });
  await call(kai.client, "add_comment", { item: filed.key, body: "Firefox" });
  const thread = await call(tara.client, "list_comments", { item: filed.key });
  expect(thread.items.map((c: Body) => c.body)).toEqual([
    "which browser?",
    "Firefox",
  ]);

  const accepted = await call(tara.client, "update_item", {
    item: filed.key,
    status: "open",
    assignee: "tara",
  });
  expect(accepted).toMatchObject({
    type: "issue",
    status: "open",
    assignee: { id: tara.actor.id, name: "Tara", kind: "bot" },
  });
  expect(
    (
      await call(tara.client, "list_items", {
        product: tara.product.key,
        status: "triage",
      })
    ).items,
  ).toEqual([]);
});

test("an issue in triage can be canceled by the product's bot", async () => {
  const tara = await productBot("Tara cancels");
  const filed = await call(await connect(bot.key), "file_issue", {
    product: tara.product.key,
    title: "duplicate",
  });
  const canceled = await call(tara.client, "update_item", {
    item: filed.key,
    status: "canceled",
  });
  expect(canceled).toMatchObject({
    status: "canceled",
    completedAt: expect.any(String),
  });
});

test("add_todo goes to the caller's one own product, open and assigned to its owner", async () => {
  const nia = await productBot("Nia");
  const todo = await call(nia.client, "add_todo", { title: "ship the canvas" });
  expect(todo).toMatchObject({
    type: "todo",
    status: "open",
    product: nia.product.key,
    project: nia.product.key,
    assignee: { id: nia.actor.id, name: "Nia", kind: "bot" },
  });
});

test("add_todo names the products to pick from when the caller owns none or several", async () => {
  const quinn = await productBot("Quinn");
  const second = await call(quinn.client, "create_product", {
    key: projectKey(),
    name: "second",
  });
  const keys = [quinn.product.key, second.key].sort();
  expect(await callError(quinn.client, "add_todo", { title: "where" })).toBe(
    `validation_failed: you own 2 products, so add_todo needs product: pick one of ${keys[0]} and ${keys[1]}`,
  );

  const scoped = createBot(db, "Holly", {
    scope: { projects: [quinn.product.key] },
  });
  expect(
    await callError(await connect(scoped.key), "add_todo", { title: "where" }),
  ).toBe(
    `validation_failed: you own no product, so add_todo needs product: pick one of ${quinn.product.key} (list_products describes each)`,
  );
});

test("add_todo in a named product defaults the assignee to that product's owner", async () => {
  const wren = await productBot("Wren");
  const helper = await connect(createBot(db, "Nora").key);
  const todo = await call(helper, "add_todo", {
    product: wren.product.key,
    title: "planned for Wren",
  });
  expect(todo.assignee).toEqual({
    id: wren.actor.id,
    name: "Wren",
    kind: "bot",
  });
});

test("file_issue on a product the key doesn't reach is the 404 an unknown product is", async () => {
  const rhea = await productBot("Rhea");
  const scoped = await connect(
    createBot(db, "Faye", { scope: { projects: [rhea.product.key] } }).key,
  );
  const hiddenOwner = await productBot("Remy");
  const hidden = await callError(scoped, "file_issue", {
    product: hiddenOwner.product.key,
    title: "x",
  });
  expect(hidden).toBe(
    `not_found: no product ${hiddenOwner.product.key}: pass the key (like TRL) of a product this key reaches; list_products (GET /api/v1/products) lists them`,
  );
  expect(
    await callError(scoped, "file_issue", { product: "ZZZZ9", title: "x" }),
  ).toBe(hidden?.replaceAll(hiddenOwner.product.key, "ZZZZ9"));
  expect(
    await call(scoped, "file_issue", {
      product: rhea.product.key,
      title: "ok",
    }),
  ).toMatchObject({ status: "triage" });
});

test("update_item changes type: todo opens an issue in triage, and a todo never goes back to triage or loses its assignee", async () => {
  const juno = await productBot("Juno");
  const ivy = await connect(createBot(db, "Ivy").key);
  const filed = await call(ivy, "file_issue", {
    product: juno.product.key,
    title: "make it a todo",
  });
  const todo = await call(juno.client, "update_item", {
    item: filed.key,
    type: "todo",
  });
  expect(todo).toMatchObject({
    type: "todo",
    status: "open",
    assigneeId: juno.actor.id,
  });
  expect(
    await callError(juno.client, "update_item", {
      item: filed.key,
      status: "triage",
    }),
  ).toBe(
    `validation_failed: ${filed.key} is a todo, and a todo is never in triage: send status open to accept it, or type issue to make it an issue first`,
  );
  expect(
    await callError(juno.client, "update_item", {
      item: filed.key,
      assignee: null,
    }),
  ).toBe(
    `validation_failed: ${filed.key} is a todo, and a todo always has an assignee: assign it to another bot, or send type issue to make it an unassigned issue`,
  );
  const issue = await call(juno.client, "update_item", {
    item: filed.key,
    type: "issue",
    assignee: null,
  });
  expect(issue).toMatchObject({
    type: "issue",
    status: "open",
    assignee: null,
  });
});

test("list_items filters by product, type, status and assignee and pages with cursor", async () => {
  const pia = await productBot("Pia");
  const lena = await connect(createBot(db, "Lena").key);
  for (const title of ["t1", "t2", "t3"]) {
    await call(pia.client, "add_todo", { title });
  }
  await call(lena, "file_issue", { product: pia.product.key, title: "i1" });
  const keys = async (args: Body) =>
    (
      await call(pia.client, "list_items", {
        product: pia.product.key,
        ...args,
      })
    ).items.map((i: Body) => i.title);
  expect(await keys({ type: "todo" })).toEqual(["t3", "t2", "t1"]);
  expect(await keys({ type: "issue", status: "triage" })).toEqual(["i1"]);
  expect(await keys({ assignee: "PIA" })).toEqual(["t3", "t2", "t1"]);

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(pia.client, "list_items", {
      product: pia.product.key,
      limit: 2,
      cursor,
    });
    seen.push(...page.items.map((i: Body) => i.title));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(["i1", "t3", "t2", "t1"]);
  expect(
    await callError(pia.client, "list_items", { assignee: "nobody at all" }),
  ).toMatch(/^validation_failed: no bot or person nobody at all to filter by/);
});

test("add_comment and list_comments work on a todo and on an issue", async () => {
  const vera = await productBot("Vera");
  const todo = await call(vera.client, "add_todo", { title: "todo" });
  const issue = await call(
    await connect(createBot(db, "Skye").key),
    "file_issue",
    { product: vera.product.key, title: "issue" },
  );
  for (const item of [todo.key, issue.key]) {
    const comment = await call(vera.client, "add_comment", {
      item,
      body: `on ${item}`,
    });
    expect(comment.authorId).toBe(vera.actor.id);
    expect(
      (await call(vera.client, "list_comments", { item })).items.map(
        (c: Body) => c.body,
      ),
    ).toEqual([`on ${item}`]);
  }
  expect(await callError(vera.client, "add_comment", { body: "where" })).toBe(
    "validation_failed: item is required: send the item's key, like TRL-12; list_items finds them",
  );
});

test("a retried add_todo or file_issue with the same idempotency_key returns the first item and writes nothing more", async () => {
  const kai = await productBot("Kai retries");
  for (const [tool, args] of [
    ["add_todo", { title: "once" }],
    ["file_issue", { product: kai.product.key, title: "once" }],
  ] as const) {
    const sent = { ...args, idempotency_key: `retry-${tool}` };
    const first = await call(kai.client, tool, sent);
    expect(await call(kai.client, tool, sent), tool).toEqual(first);
  }
  const all = await call(kai.client, "list_items", {
    product: kai.product.key,
  });
  expect(all.items).toHaveLength(2);
  expect(
    await callError(kai.client, "file_issue", {
      product: kai.product.key,
      title: "once",
      idempotency_key: "retry-add_todo",
    }),
  ).toMatch(/^idempotency_key_reused: /);
});

test("add_todo, file_issue and update_item each say when to use a todo and when an issue", async () => {
  const { tools } = await (await connect(bot.key)).listTools();
  for (const name of ["add_todo", "file_issue", "update_item"]) {
    const description = tools.find((t) => t.name === name)?.description;
    expect(description, name).toMatch(/A todo is planned work/);
    expect(description, name).toMatch(
      /starts in triage until that bot accepts it \(status open\) or cancels it/,
    );
  }
});

test("update_item says to name an assignee when accepting an issue, since status open alone leaves it unassigned", async () => {
  const { tools } = await (await connect(bot.key)).listTools();
  const description = tools.find((t) => t.name === "update_item")?.description;
  expect(description).toMatch(
    /To accept an issue from your product's triage send status open with assignee/,
  );
});
