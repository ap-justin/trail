import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";
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
  const alpha = await productBot("Gamma");
  const beta = await productBot("Beta");

  const filed = await call(beta.client, "file_issue", {
    product: alpha.product.key,
    title: "the export button does nothing",
    description: "steps: click Export",
  });
  expect(filed).toMatchObject({
    key: `${alpha.product.key}-1`,
    type: "issue",
    status: "triage",
    product: alpha.product.key,
    assignee: null,
    createdBy: beta.actor.id,
  });

  const triage = await call(alpha.client, "list_items", {
    product: alpha.product.key,
    status: "triage",
  });
  expect(triage.items.map((i: Body) => i.key)).toEqual([filed.key]);

  await call(alpha.client, "add_comment", {
    item: filed.key,
    body: "which browser?",
  });
  await call(beta.client, "add_comment", { item: filed.key, body: "Firefox" });
  const thread = await call(alpha.client, "list_comments", { item: filed.key });
  expect(thread.items.map((c: Body) => c.body)).toEqual([
    "which browser?",
    "Firefox",
  ]);

  const accepted = await call(alpha.client, "update_item", {
    item: filed.key,
    status: "open",
    assignee: "gamma",
  });
  expect(accepted).toMatchObject({
    type: "issue",
    status: "open",
    assignee: { id: alpha.actor.id, name: "Gamma", kind: "bot" },
  });
  expect(
    (
      await call(alpha.client, "list_items", {
        product: alpha.product.key,
        status: "triage",
      })
    ).items,
  ).toEqual([]);
});

test("Alpha, who owns TRL, accepts a TRL issue from triage and adds a TRL todo, and files an issue on ATL, where add_todo is refused with the next step", async () => {
  const alpha = createBot(db, "Alpha");
  const tc = await connect(alpha.key);
  const trl = await call(tc, "create_product", { key: "TRL", name: "trail" });
  const tau = createBot(db, "Tau");
  await call(await connect(tau.key), "create_product", {
    key: "ATL",
    name: "tau",
  });

  const filed = await call(await connect(bot.key), "file_issue", {
    product: "TRL",
    title: "the feed skips a row",
  });
  expect(
    await call(tc, "update_item", {
      item: filed.key,
      status: "open",
      assignee: "Alpha",
    }),
  ).toMatchObject({ status: "open", assignee: { name: "Alpha" } });
  expect(await call(tc, "add_todo", { title: "fix the feed" })).toMatchObject({
    type: "todo",
    product: trl.key,
    assignee: { name: "Alpha" },
  });
  expect(
    await call(tc, "file_issue", { product: "ATL", title: "tau crashes" }),
  ).toMatchObject({ type: "issue", status: "triage", product: "ATL" });
  expect(
    await callError(tc, "add_todo", { product: "ATL", title: "fix tau" }),
  ).toBe(
    "forbidden: ATL is owned by Tau, so only Tau adds its todos: file the work as an issue with file_issue (POST /items with type issue), and Tau accepts it from triage",
  );
});

test("on a product with an owner, only the owner accepts, cancels or retypes its triage issues; the filer may cancel its own", async () => {
  const owner = await productBot("Delta");
  const filer = await connect(createBot(db, "Fern").key);
  const other = await connect(createBot(db, "Olin").key);
  const key = owner.product.key;
  const filed = await call(filer, "file_issue", { product: key, title: "x" });
  for (const patch of [
    { status: "open", assignee: "Olin" },
    { status: "in_progress" },
    { status: "canceled" },
  ]) {
    expect(
      await callError(other, "update_item", { item: filed.key, ...patch }),
      JSON.stringify(patch),
    ).toBe(
      `forbidden: ${filed.key} is in the triage of ${key}, which Delta owns: only Delta accepts or cancels it, and its filer may cancel it. Comment on it with add_comment to ask Delta`,
    );
  }
  expect(
    await callError(other, "update_item", { item: filed.key, type: "todo" }),
  ).toBe(
    `forbidden: only Delta, the owner of ${key}, changes an item's type between todo and issue: comment on ${filed.key} with add_comment to ask Delta`,
  );
  expect(
    await call(other, "update_item", {
      item: filed.key,
      priority: 2,
      addLabels: ["bug"],
    }),
  ).toMatchObject({
    status: "triage",
    priority: 2,
    labels: [],
    skippedLabels: ["bug"],
  });
  expect(
    await callError(filer, "update_item", { item: filed.key, status: "open" }),
  ).toMatch(/^forbidden: /);
  expect(
    await call(filer, "update_item", { item: filed.key, status: "canceled" }),
  ).toMatchObject({ status: "canceled" });
});

test("on a product with an owner, only the owner or the filer cancels an item at any status; anyone else is refused and changes nothing", async () => {
  const owner = await productBot("alpha cancel");
  const filer = await connect(createBot(db, "beta cancel").key);
  const outsider = await connect(createBot(db, "gamma cancel").key);
  const key = owner.product.key;
  const refusal = (item: string) =>
    `forbidden: ${item} is on ${key}, which alpha cancel owns: only alpha cancel or the bot that filed it cancels it. Comment on it with add_comment to ask alpha cancel`;
  const accepted = async (title: string) => {
    const filed = await call(filer, "file_issue", { product: key, title });
    await call(owner.client, "update_item", {
      item: filed.key,
      status: "open",
      assignee: "alpha cancel",
    });
    return filed.key as string;
  };

  const issue = await accepted("a");
  const todo = (await call(owner.client, "add_todo", { title: "b" }))
    .key as string;
  for (const item of [issue, todo]) {
    expect(
      await callError(outsider, "update_item", { item, status: "canceled" }),
      item,
    ).toBe(refusal(item));
    expect(await call(owner.client, "get_item", { item }), item).toMatchObject({
      status: "open",
    });
  }
  expect(
    await call(filer, "update_item", { item: issue, status: "canceled" }),
  ).toMatchObject({ status: "canceled" });
  expect(
    await call(owner.client, "update_item", { item: todo, status: "canceled" }),
  ).toMatchObject({ status: "canceled" });
  const another = await accepted("c");
  expect(
    await call(owner.client, "update_item", {
      item: another,
      status: "canceled",
    }),
  ).toMatchObject({ status: "canceled" });
});

test("anyone reopens a canceled todo, even one another bot filed as an issue; a canceled issue that bot filed only the owner reopens", async () => {
  const owner = await productBot("alpha todo reopen");
  const filer = await connect(createBot(db, "beta todo reopen").key);
  const outsider = await connect(createBot(db, "gamma todo reopen").key);
  const key = owner.product.key;
  const filed = await call(filer, "file_issue", { product: key, title: "a" });
  await call(owner.client, "update_item", { item: filed.key, type: "todo" });
  await call(filer, "update_item", { item: filed.key, status: "canceled" });
  expect(
    await call(outsider, "update_item", { item: filed.key, status: "open" }),
  ).toMatchObject({ type: "todo", status: "open" });

  const issue = await call(filer, "file_issue", { product: key, title: "b" });
  await call(filer, "update_item", { item: issue.key, status: "canceled" });
  expect(
    await callError(outsider, "update_item", {
      item: issue.key,
      status: "open",
    }),
  ).toMatch(/^forbidden: .* only alpha todo reopen reopens it\./);
});

test("update_item on another bot's product attaches only labels the product has and lists the rest in skippedLabels; the owner creates them", async () => {
  const owner = await productBot("alpha labels");
  const outsider = await connect(createBot(db, "beta labels").key);
  await call(owner.client, "create_label", {
    product: owner.product.key,
    name: "ui",
  });
  const filed = await call(outsider, "file_issue", {
    product: owner.product.key,
    title: "labels",
  });
  expect(
    await call(outsider, "update_item", {
      item: filed.key,
      addLabels: ["UI", "made-up"],
    }),
  ).toMatchObject({ labels: ["ui"], skippedLabels: ["made-up"] });
  expect(
    await call(outsider, "update_item", {
      item: filed.key,
      labels: ["other-made-up"],
    }),
  ).toMatchObject({ labels: [], skippedLabels: ["other-made-up"] });
  const unskipped = await call(outsider, "update_item", {
    item: filed.key,
    labels: ["ui"],
  });
  expect(unskipped.labels).toEqual(["ui"]);
  expect(unskipped).not.toHaveProperty("skippedLabels");
  const labels = await call(owner.client, "list_labels", {
    product: owner.product.key,
  });
  expect(labels.items.map((l: Body) => l.name)).toEqual(["ui"]);
  expect(
    await call(owner.client, "update_item", {
      item: filed.key,
      addLabels: ["made-up"],
    }),
  ).toMatchObject({ labels: ["made-up", "ui"] });
});

test("reopening a canceled issue a non-owner filed is the owner's decision, so a filer's cancel is no way out of triage", async () => {
  const owner = await productBot("alpha reopen");
  const filer = await connect(createBot(db, "beta reopen").key);
  const other = await connect(createBot(db, "gamma reopen").key);
  const key = owner.product.key;
  const refusal = (item: string) =>
    `forbidden: ${item} was filed on ${key}, which alpha reopen owns, and was canceled: only alpha reopen reopens it. Comment on it with add_comment to ask alpha reopen`;

  const own = await call(filer, "file_issue", { product: key, title: "a" });
  await call(filer, "update_item", { item: own.key, status: "canceled" });
  for (const status of ["open", "in_progress", "triage", "done"]) {
    expect(
      await callError(filer, "update_item", { item: own.key, status }),
      status,
    ).toBe(refusal(own.key));
  }

  const declined = await call(filer, "file_issue", {
    product: key,
    title: "b",
  });
  await call(owner.client, "update_item", {
    item: declined.key,
    status: "canceled",
  });
  expect(
    await callError(other, "update_item", {
      item: declined.key,
      status: "open",
    }),
  ).toBe(refusal(declined.key));
  expect(
    await call(owner.client, "update_item", {
      item: declined.key,
      status: "open",
    }),
  ).toMatchObject({ status: "open" });
});

test("a product with no owner leaves todos and triage open to any bot that reaches it", async () => {
  const opener = await productBot("Nobody's");
  await call(opener.client, "update_product", {
    product: opener.product.key,
    owner: null,
  });
  const other = await connect(createBot(db, "Anyone").key);
  const todo = await call(other, "add_todo", {
    product: opener.product.key,
    title: "unowned work",
  });
  expect(todo).toMatchObject({ type: "todo", assignee: { name: "Anyone" } });
  const filed = await call(other, "file_issue", {
    product: opener.product.key,
    title: "unowned report",
  });
  expect(
    await call(other, "update_item", { item: filed.key, status: "open" }),
  ).toMatchObject({ status: "open" });
  const third = await connect(createBot(db, "Anyone else").key);
  for (const item of [todo.key, filed.key]) {
    expect(
      await call(third, "update_item", { item, status: "canceled" }),
      item,
    ).toMatchObject({ status: "canceled" });
  }
});

test("accepting an issue from triage with status open and no assignee leaves it open and unassigned", async () => {
  const alpha = await productBot("Alpha accepts");
  const filed = await call(await connect(bot.key), "file_issue", {
    product: alpha.product.key,
    title: "accept me bare",
  });
  const accepted = await call(alpha.client, "update_item", {
    item: filed.key,
    status: "open",
  });
  expect(accepted).toMatchObject({
    type: "issue",
    status: "open",
    assignee: null,
  });
  const read = await call(alpha.client, "get_item", { item: filed.key });
  expect(read).toMatchObject({ status: "open", assignee: null });
});

test("an issue in triage can be canceled by the product's bot", async () => {
  const alpha = await productBot("Alpha cancels");
  const filed = await call(await connect(bot.key), "file_issue", {
    product: alpha.product.key,
    title: "duplicate",
  });
  const canceled = await call(alpha.client, "update_item", {
    item: filed.key,
    status: "canceled",
  });
  expect(canceled).toMatchObject({
    status: "canceled",
    completedAt: expect.any(String),
  });
});

test("add_todo goes to the caller's one own product, open and assigned to its owner", async () => {
  const epsilon = await productBot("Epsilon");
  const todo = await call(epsilon.client, "add_todo", {
    title: "ship the canvas",
  });
  expect(todo).toMatchObject({
    type: "todo",
    status: "open",
    product: epsilon.product.key,
    project: epsilon.product.key,
    assignee: { id: epsilon.actor.id, name: "Epsilon", kind: "bot" },
  });
});

test("add_todo names the products to pick from when the caller owns none or several", async () => {
  const kappa = await productBot("Kappa");
  const second = await call(kappa.client, "create_product", {
    key: projectKey(),
    name: "second",
  });
  const keys = [kappa.product.key, second.key].sort();
  expect(await callError(kappa.client, "add_todo", { title: "where" })).toBe(
    `validation_failed: you own 2 products, so add_todo needs product: pick one of ${keys[0]} and ${keys[1]}`,
  );

  const scoped = createBot(db, "Pi", {
    scope: { projects: [kappa.product.key] },
  });
  expect(
    await callError(await connect(scoped.key), "add_todo", { title: "where" }),
  ).toBe(
    `validation_failed: you own no product, so add_todo needs product: pick one of ${kappa.product.key} (list_products describes each)`,
  );
});

test("file_issue on a product the key doesn't reach is the 404 an unknown product is", async () => {
  const mu = await productBot("Mu");
  const scoped = await connect(
    createBot(db, "Omicron", { scope: { projects: [mu.product.key] } }).key,
  );
  const hiddenOwner = await productBot("Lambda");
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
      product: mu.product.key,
      title: "ok",
    }),
  ).toMatchObject({ status: "triage" });
});

test("update_item changes type: todo opens an issue in triage, and a todo never goes back to triage or loses its assignee", async () => {
  const eta = await productBot("Eta");
  const zeta = await connect(createBot(db, "Zeta").key);
  const filed = await call(zeta, "file_issue", {
    product: eta.product.key,
    title: "make it a todo",
  });
  const todo = await call(eta.client, "update_item", {
    item: filed.key,
    type: "todo",
  });
  expect(todo).toMatchObject({
    type: "todo",
    status: "open",
    assigneeId: eta.actor.id,
  });
  expect(
    await callError(eta.client, "update_item", {
      item: filed.key,
      status: "triage",
    }),
  ).toBe(
    `validation_failed: ${filed.key} is a todo, and a todo is never in triage: send type issue with status triage in the same update to put it in triage as an issue, or another status to keep it a todo`,
  );
  expect(
    await callError(eta.client, "update_item", {
      item: filed.key,
      assignee: null,
    }),
  ).toBe(
    `validation_failed: ${filed.key} is a todo, and a todo always has an assignee: assign it to another bot, or send type issue to make it an unassigned issue`,
  );
  const issue = await call(eta.client, "update_item", {
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
  const iota = await productBot("Iota");
  const theta = await connect(createBot(db, "Theta").key);
  // one stamp apiece: same-millisecond rows would order by random id
  await atFakeTimeAsync([
    ...["t1", "t2", "t3"].map(
      (title) => () => call(iota.client, "add_todo", { title }),
    ),
    () => call(theta, "file_issue", { product: iota.product.key, title: "i1" }),
  ]);
  const keys = async (args: Body) =>
    (
      await call(iota.client, "list_items", {
        product: iota.product.key,
        ...args,
      })
    ).items.map((i: Body) => i.title);
  expect(await keys({ type: "todo" })).toEqual(["t3", "t2", "t1"]);
  expect(await keys({ type: "issue", status: "triage" })).toEqual(["i1"]);
  expect(await keys({ assignee: "IOTA" })).toEqual(["t3", "t2", "t1"]);

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(iota.client, "list_items", {
      product: iota.product.key,
      limit: 2,
      cursor,
    });
    seen.push(...page.items.map((i: Body) => i.title));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(["i1", "t3", "t2", "t1"]);
  expect(
    await callError(iota.client, "list_items", { assignee: "nobody at all" }),
  ).toMatch(/^validation_failed: no bot or person nobody at all to filter by/);
});

test("add_comment and list_comments work on a todo and on an issue", async () => {
  const xi = await productBot("Xi");
  const todo = await call(xi.client, "add_todo", { title: "todo" });
  const issue = await call(
    await connect(createBot(db, "Nu").key),
    "file_issue",
    { product: xi.product.key, title: "issue" },
  );
  for (const item of [todo.key, issue.key]) {
    const comment = await call(xi.client, "add_comment", {
      item,
      body: `on ${item}`,
    });
    expect(comment.authorId).toBe(xi.actor.id);
    expect(
      (await call(xi.client, "list_comments", { item })).items.map(
        (c: Body) => c.body,
      ),
    ).toEqual([`on ${item}`]);
  }
  expect(await callError(xi.client, "add_comment", { body: "where" })).toBe(
    "validation_failed: item is required: send the item's key, like TRL-12; list_items finds them",
  );
});

test("a retried add_todo or file_issue with the same idempotency_key returns the first item and writes nothing more", async () => {
  const beta = await productBot("Beta retries");
  for (const [tool, args] of [
    ["add_todo", { title: "once" }],
    ["file_issue", { product: beta.product.key, title: "once" }],
  ] as const) {
    const sent = { ...args, idempotency_key: `retry-${tool}` };
    const first = await call(beta.client, tool, sent);
    expect(await call(beta.client, tool, sent), tool).toEqual(first);
  }
  const all = await call(beta.client, "list_items", {
    product: beta.product.key,
  });
  expect(all.items).toHaveLength(2);
  expect(
    await callError(beta.client, "file_issue", {
      product: beta.product.key,
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
      /starts in triage until that bot accepts it \(status open with assignee, the bot that will work on it\) or cancels it/,
    );
  }
});

test("the server's instructions say to accept an issue with status open and an assignee", async () => {
  const client = await connect(bot.key);
  expect(client.getInstructions()).toMatch(
    /accepts it with update_item status open and assignee, the bot that will work on it/,
  );
});

test("update_item says to name an assignee when accepting an issue, since status open alone leaves it unassigned", async () => {
  const { tools } = await (await connect(bot.key)).listTools();
  const description = tools.find((t) => t.name === "update_item")?.description;
  expect(description).toMatch(
    /To accept an issue from your product's triage send status open with assignee/,
  );
});

test("update_product can't make a bot owner of another bot's product, so it can't then add todos there", async () => {
  const owner = await productBot("Orla");
  const grabber = await productBot("Grabber");
  const key = owner.product.key;
  expect(
    await callError(grabber.client, "update_product", {
      product: key,
      owner: "Grabber",
    }),
  ).toBe(
    `forbidden: ${key} is owned by Orla: only Orla may hand it to another bot or clear its owner over the API. The operator reassigns it with \`trail products set-owner ${key} <bot>\``,
  );
  expect(
    await callError(grabber.client, "update_product", {
      product: key,
      owner: null,
    }),
  ).toBe(
    `forbidden: ${key} is owned by Orla: only Orla may hand it to another bot or clear its owner over the API. The operator reassigns it with \`trail products set-owner ${key} <bot>\``,
  );
  expect(
    await callError(grabber.client, "add_todo", { product: key, title: "x" }),
  ).toMatch(/^forbidden: .* is owned by Orla/);
  expect(
    await call(owner.client, "update_product", {
      product: key,
      owner: "Grabber",
    }),
  ).toMatchObject({ owner: { name: "Grabber" } });
  expect(
    await call(grabber.client, "add_todo", { product: key, title: "mine now" }),
  ).toMatchObject({ type: "todo", assignee: { name: "Grabber" } });
});

test("file_issue on another bot's product attaches only labels the product has, and lists the rest in skippedLabels", async () => {
  const owner = await productBot("Theta labels");
  const key = owner.product.key;
  await call(owner.client, "create_label", { product: key, name: "Bug" });
  const filer = await connect(createBot(db, "Label filer").key);
  const args = {
    product: key,
    title: "labelled from outside",
    labels: ["bug", "spam", "Spam"],
    idempotency_key: "outside labels",
  };
  const filed = await call(filer, "file_issue", args);
  expect(filed).toMatchObject({ labels: ["Bug"], skippedLabels: ["spam"] });
  expect(await call(filer, "file_issue", args)).toEqual(filed);
  const labels = await call(owner.client, "list_labels", { product: key });
  expect(labels.items.map((l: Body) => l.name)).toEqual(["Bug"]);

  const own = await call(owner.client, "file_issue", {
    product: key,
    title: "labelled by the owner",
    labels: ["Spam"],
  });
  expect(own.labels).toEqual(["Spam"]);
  expect(own).not.toHaveProperty("skippedLabels");
});
