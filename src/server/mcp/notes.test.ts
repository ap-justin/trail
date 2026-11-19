import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { webhookDelivery } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

/** A bot that owns one product of its own, with an MCP client. */
async function productBot(name: string) {
  const made = createBot(db, name);
  const client = await connect(made.key);
  const product = await call(client, "create_product", {
    key: projectKey(),
    name,
  });
  return { ...made, client, product: product.key as string };
}

test("add_note on a product the caller doesn't own: current, unassigned, no triage, numbered with its items", async () => {
  const owner = await productBot("Nora");
  const reader = await productBot("Rhea");
  await call(owner.client, "add_todo", { title: "first" });

  const note = await call(reader.client, "add_note", {
    product: owner.product,
    title: "how the export works",
    description: "it streams rows as CSV",
  });
  expect(note).toMatchObject({
    key: `${owner.product}-2`,
    type: "note",
    status: "current",
    assignee: null,
    completedAt: null,
    createdBy: reader.actor.id,
    about: [],
  });
});

test("about points a note at items in other products, and get_item reads it both ways", async () => {
  const atlas = await productBot("Atlas");
  const boreas = await productBot("Boreas");
  const scribe = await productBot("Scribe");
  const todo = await call(atlas.client, "add_todo", { title: "ship export" });
  const issue = await call(scribe.client, "file_issue", {
    product: boreas.product,
    title: "import drops rows",
  });

  const note = await call(scribe.client, "add_note", {
    product: scribe.product,
    title: "export and import share a CSV dialect",
    about: [issue.key, todo.key, todo.key],
  });
  expect(note.about).toEqual(
    [
      { key: todo.key, title: "ship export", type: "todo", status: "open" },
      {
        key: issue.key,
        title: "import drops rows",
        type: "issue",
        status: "triage",
      },
    ].sort((a, b) => (a.key < b.key ? -1 : 1)),
  );
  expect(
    await call(atlas.client, "get_item", { item: note.key }),
  ).toMatchObject({ about: note.about });
  expect(
    (await call(atlas.client, "get_item", { item: todo.key })).notes,
  ).toEqual([
    { key: note.key, title: note.title, type: "note", status: "current" },
  ]);
  expect(
    (await call(atlas.client, "get_item", { item: issue.key })).notes,
  ).toEqual([
    { key: note.key, title: note.title, type: "note", status: "current" },
  ]);
});

test("about refuses a key the caller doesn't reach, naming it, and more than 50 keys", async () => {
  const hidden = await productBot("Hydra");
  const secret = await call(hidden.client, "add_todo", { title: "secret" });
  const own = await productBot("Ione");
  const scoped = await connect(
    createBot(db, "Scoped", { scope: { products: [own.product] } }).key,
  );
  expect(
    await callError(scoped, "add_note", {
      product: own.product,
      title: "about something hidden",
      about: [secret.key],
    }),
  ).toBe(
    `validation_failed: about names ${secret.key}, which this key doesn't reach or which doesn't exist: send keys like TRL-12 of items get_item finds`,
  );
  expect(
    await callError(scoped, "add_note", {
      product: own.product,
      title: "about too much",
      about: Array.from({ length: 51 }, (_, i) => `${own.product}-${i + 1}`),
    }),
  ).toMatch(/<=50 items at about/);
});

test("get_item on a todo hides a note from a product the key doesn't reach, and shows it to a key that does", async () => {
  const own = await productBot("Olga");
  const elsewhere = await productBot("Elsa");
  const todo = await call(own.client, "add_todo", { title: "reachable work" });
  const note = await call(elsewhere.client, "add_note", {
    product: elsewhere.product,
    title: "kept out of sight",
    about: [todo.key],
  });
  const scoped = await connect(
    createBot(db, "Olga only", { scope: { products: [own.product] } }).key,
  );
  const seen = await call(scoped, "get_item", { item: todo.key });
  expect(seen.title).toBe("reachable work");
  expect(seen.notes).toEqual([]);
  expect(JSON.stringify(seen)).not.toContain("kept out of sight");
  expect(
    (await call(elsewhere.client, "get_item", { item: todo.key })).notes,
  ).toEqual([
    { key: note.key, title: note.title, type: "note", status: "current" },
  ]);
});

test("add_note with an idempotency key returns the first note on a retry and adds nothing", async () => {
  const owner = await productBot("Idem");
  const writer = await productBot("Iris");
  const args = {
    product: owner.product,
    title: "a record",
    idempotency_key: "note-1",
  };
  const first = await call(writer.client, "add_note", args);
  expect(await call(writer.client, "add_note", args)).toEqual(first);
  const notes = await call(writer.client, "list_items", {
    product: owner.product,
    type: "note",
  });
  expect(notes.items.map((i: Body) => i.key)).toEqual([first.key]);
});

test("list_items lists notes only with type note; without type, issues and todos as before", async () => {
  const owner = await productBot("Lister");
  const todo = await call(owner.client, "add_todo", { title: "work" });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  const keys = async (args: Body) =>
    (await call(owner.client, "list_items", args)).items.map(
      (i: Body) => i.key,
    );
  expect(await keys({ product: owner.product })).toEqual([todo.key]);
  expect(await keys({ product: owner.product, type: "note" })).toEqual([
    note.key,
  ]);
  expect(
    await keys({ product: owner.product, type: "note", status: "current" }),
  ).toEqual([note.key]);
  expect(
    await keys({ product: owner.product, type: "note", status: "archived" }),
  ).toEqual([]);
  expect(
    await callError(owner.client, "list_items", {
      product: owner.product,
      status: "current",
    }),
  ).toBe(
    "validation_failed: status current is a note's, and list_items without type lists issues and todos: send type note with it",
  );
  expect(
    await callError(owner.client, "list_items", {
      product: owner.product,
      type: "note",
      status: "open",
    }),
  ).toBe(
    "validation_failed: a note's status is current or archived, so type note takes status current or archived, not open",
  );
});

test("a note's author and the product's bot edit it; a third bot is told to comment", async () => {
  const owner = await productBot("Editor");
  const author = await productBot("Author");
  const third = await productBot("Third");
  const note = await call(author.client, "add_note", {
    product: owner.product,
    title: "draft",
  });
  expect(
    await call(author.client, "update_item", {
      item: note.key,
      title: "by the author",
    }),
  ).toMatchObject({ title: "by the author" });
  expect(
    await call(owner.client, "update_item", {
      item: note.key,
      description: "by the owner",
    }),
  ).toMatchObject({ description: "by the owner" });
  expect(
    await callError(third.client, "update_item", {
      item: note.key,
      title: "by a third bot",
    }),
  ).toBe(
    `forbidden: ${note.key} is a note by Author, and only Author and Editor, the bot of ${owner.product}, edit it: add what you know with add_comment on ${note.key}`,
  );
  await call(third.client, "add_comment", { item: note.key, body: "also" });
});

test("a note's status is current or archived, an issue's or a todo's never is, and each refusal names the valid ones", async () => {
  const owner = await productBot("Stater");
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  const todo = await call(owner.client, "add_todo", { title: "work" });
  const issue = await call(owner.client, "file_issue", {
    product: owner.product,
    title: "ask",
  });
  expect(
    await call(owner.client, "update_item", {
      item: note.key,
      status: "archived",
    }),
  ).toMatchObject({ status: "archived", completedAt: null });
  expect(
    await call(owner.client, "update_item", {
      item: note.key,
      status: "current",
    }),
  ).toMatchObject({ status: "current" });
  expect(
    await callError(owner.client, "update_item", {
      item: note.key,
      status: "done",
    }),
  ).toBe(
    `validation_failed: ${note.key} is a note, and a note's status is current or archived, not done: send one of those, or type issue or todo to make it work someone does`,
  );
  expect(
    await callError(owner.client, "update_item", {
      item: note.key,
      assignee: "Stater",
    }),
  ).toBe(
    `validation_failed: ${note.key} is a note, and a note has no assignee: file an issue (file_issue) for work someone has to do, and list it in the note's about`,
  );
  for (const item of [todo, issue]) {
    expect(
      await callError(owner.client, "update_item", {
        item: item.key,
        status: "archived",
      }),
    ).toBe(
      `validation_failed: ${item.key} is ${item.type === "todo" ? "a todo" : "an issue"}, and current and archived are a note's statuses: send ${item.type === "todo" ? "open, in_progress, done or canceled" : "triage, open, in_progress, done or canceled"}, or type note with it to make it a note`,
    );
  }
});

test("update_item replaces, adds to and removes from about, never about with addAbout or removeAbout", async () => {
  const owner = await productBot("Abouter");
  const items: Body[] = [];
  for (const title of ["a", "b", "c"]) {
    items.push(await call(owner.client, "add_todo", { title }));
  }
  const keyOf = (i: number) => items[i]?.key as string;
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
    about: [keyOf(0)],
  });
  const aboutKeys = (item: Body) => item.about.map((r: Body) => r.key);
  expect(
    aboutKeys(
      await call(owner.client, "update_item", {
        item: note.key,
        addAbout: [keyOf(1), keyOf(2)],
        removeAbout: [keyOf(0), "ZZ-404"],
      }),
    ),
  ).toEqual([keyOf(1), keyOf(2)]);
  expect(
    aboutKeys(
      await call(owner.client, "update_item", {
        item: note.key,
        about: [keyOf(0)],
      }),
    ),
  ).toEqual([keyOf(0)]);
  expect(
    await callError(owner.client, "update_item", {
      item: note.key,
      about: [keyOf(1)],
      addAbout: [keyOf(2)],
    }),
  ).toBe(
    "validation_failed: about replaces the whole set, so it cannot go with addAbout or removeAbout: send about alone to replace the set, or addAbout and removeAbout to change part of it",
  );
  expect(
    await callError(owner.client, "update_item", {
      item: note.key,
      addAbout: [note.key],
    }),
  ).toBe(
    `validation_failed: addAbout names ${note.key}, the note itself: a note is about other items`,
  );
  expect(
    await callError(owner.client, "update_item", {
      item: keyOf(1),
      about: [keyOf(0)],
    }),
  ).toBe(
    `validation_failed: ${keyOf(1)} is a todo, and about, addAbout and removeAbout are a note's, the items it is about: add a note about ${keyOf(1)} with add_note instead`,
  );
});

test("only the product's bot turns an item into a note: it keeps its key, drops its assignee and leaves triage for current", async () => {
  const owner = await productBot("Converter");
  const filer = await productBot("Filer");
  const issue = await call(filer.client, "file_issue", {
    product: owner.product,
    title: "is this a bug?",
  });
  expect(
    await callError(filer.client, "update_item", {
      item: issue.key,
      type: "note",
    }),
  ).toBe(
    `forbidden: only Converter, the owner of ${owner.product}, turns an item into a note: comment on ${issue.key} with add_comment to ask Converter`,
  );
  const todo = await call(owner.client, "add_todo", { title: "assigned" });
  for (const item of [issue, todo]) {
    expect(
      await call(owner.client, "update_item", { item: item.key, type: "note" }),
    ).toMatchObject({
      key: item.key,
      type: "note",
      status: "current",
      assignee: null,
      about: [],
    });
  }
  expect(
    await callError(owner.client, "update_item", {
      item: todo.key,
      type: "issue",
      status: "archived",
    }),
  ).toBe(
    `validation_failed: type issue makes ${todo.key} an issue, and current and archived are a note's statuses: send triage, open, in_progress, done or canceled, or type note with it to make it a note`,
  );
});

test("a note turned back into an issue goes to triage, into a todo opens with the owner assigned, and is about nothing any more", async () => {
  const owner = await productBot("Reverter");
  const author = await productBot("Writer");
  const target = await call(owner.client, "add_todo", { title: "target" });
  const toIssue = await call(author.client, "add_note", {
    product: owner.product,
    title: "becomes an issue",
    about: [target.key],
  });
  const toTodo = await call(author.client, "add_note", {
    product: owner.product,
    title: "becomes a todo",
  });
  expect(
    await callError(author.client, "update_item", {
      item: toIssue.key,
      type: "issue",
    }),
  ).toBe(
    `forbidden: only Reverter, the owner of ${owner.product}, turns a note into work: comment on ${toIssue.key} with add_comment to ask Reverter`,
  );
  const issue = await call(owner.client, "update_item", {
    item: toIssue.key,
    type: "issue",
  });
  expect(issue).toMatchObject({
    type: "issue",
    status: "triage",
    assignee: null,
  });
  expect(issue.about).toBeUndefined();
  expect(
    (await call(owner.client, "get_item", { item: target.key })).notes,
  ).toEqual([]);
  expect(
    await call(owner.client, "update_item", { item: toTodo.key, type: "todo" }),
  ).toMatchObject({
    type: "todo",
    status: "open",
    assignee: { name: "Reverter" },
  });
});

test("get_project and get_product count notes apart from the work counts", async () => {
  const owner = await productBot("Counter");
  await call(owner.client, "add_todo", { title: "work" });
  const project = await call(owner.client, "create_project", {
    name: "Counted",
  });
  const added = [];
  for (const title of ["one", "two", "three"]) {
    added.push(
      await call(owner.client, "add_note", {
        product: owner.product,
        project: project.slug,
        title,
      }),
    );
  }
  await call(owner.client, "update_item", {
    item: added[0]?.key,
    status: "archived",
  });
  const todo = await call(owner.client, "add_todo", { title: "more work" });
  await call(owner.client, "add_to_project", {
    project: project.slug,
    items: [todo.key],
  });
  expect(
    await call(owner.client, "get_project", { project: project.slug }),
  ).toMatchObject({
    counts: { triage: 0, open: 1, in_progress: 0, done: 0, canceled: 0 },
    notes: { current: 2, archived: 1 },
  });
  expect(
    await call(owner.client, "get_product", { product: owner.product }),
  ).toMatchObject({ notes: { current: 2, archived: 1 } });
});

test("the deprecated issue tools never show a note", async () => {
  const owner = await productBot("Legacy");
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  expect(
    (await call(owner.client, "list_issues", { product: owner.product })).items,
  ).toEqual([]);
  expect(
    await callError(owner.client, "get_issue", { issueId: note.key }),
  ).toMatch(/^not_found: /);
  expect(
    await callError(owner.client, "update_issue", {
      issueId: note.key,
      title: "x",
    }),
  ).toMatch(/^not_found: /);
});

test("writing a note needs the issues action, as filing an issue does", async () => {
  const owner = await productBot("Scope");
  const reader = await connect(
    createBot(db, "Reader", { scope: { actions: ["read", "comments"] } }).key,
  );
  expect(
    await callError(reader, "add_note", {
      product: owner.product,
      title: "record",
    }),
  ).toMatch(
    /^forbidden_action: this key may not add a note: that needs the issues action/,
  );
});

test("a note's events go out as trail.item.* with type note, and never under the deprecated trail.issue.* names", async () => {
  const owner = await productBot("Hooked");
  const { id } = await call(owner.client, "create_webhook", {
    url: "https://hooked.example.com/hook",
    secret: "whsec_notes_0123456789",
    products: [owner.product],
  });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  await call(owner.client, "update_item", {
    item: note.key,
    status: "archived",
  });
  const todo = await call(owner.client, "add_todo", { title: "work" });
  await call(owner.client, "update_item", { item: todo.key, type: "note" });
  const deliveries = db
    .select({ type: webhookDelivery.type })
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, id))
    .orderBy(webhookDelivery.seq, webhookDelivery.type)
    .all()
    .map((d) => d.type);
  expect(deliveries).toEqual([
    "trail.item.created",
    "trail.item.updated",
    "trail.issue.created",
    "trail.item.created",
    "trail.item.updated",
  ]);
  const created = (
    await call(owner.client, "list_activity", { product: owner.product })
  ).items.find(
    (e: Body) => e.action === "issue.created" && e.payload.key === note.key,
  );
  expect(created.payload).toMatchObject({ type: "note", status: "current" });
});
