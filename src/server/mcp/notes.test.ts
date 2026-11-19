import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { activityEvent, webhookDelivery } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { buildEnvelope } from "../webhooks/payload.js";
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

test("get_item lists the 50 newest current notes about an item and counts all it reaches in notesCount", async () => {
  const owner = await productBot("Crowded");
  const elsewhere = await productBot("Faraway");
  const todo = await call(owner.client, "add_todo", { title: "popular" });
  const keys: string[] = [];
  for (let i = 0; i < 52; i++) {
    keys.push(
      (
        await call(owner.client, "add_note", {
          product: owner.product,
          title: `note ${i}`,
          about: [todo.key],
        })
      ).key,
    );
  }
  await call(owner.client, "update_item", {
    item: keys[51],
    status: "archived",
  });
  await call(elsewhere.client, "add_note", {
    product: elsewhere.product,
    title: "out of reach",
    about: [todo.key],
  });
  const scoped = await connect(
    createBot(db, "Crowded only", { scope: { products: [owner.product] } }).key,
  );
  const read = await call(scoped, "get_item", { item: todo.key });
  expect(read.notes.map((n: Body) => n.key)).toEqual(
    keys.slice(1, 51).reverse(),
  );
  expect(read.notesCount).toEqual({ current: 51, archived: 1 });
  expect(
    (await call(elsewhere.client, "get_item", { item: todo.key })).notesCount,
  ).toEqual({ current: 52, archived: 1 });
});

test("list_items with about pages every note about the item, with or without type note, and with a note status", async () => {
  const owner = await productBot("Paged");
  const hidden = await productBot("Hidden");
  const todo = await call(owner.client, "add_todo", { title: "talked about" });
  const other = await call(owner.client, "add_todo", { title: "elsewhere" });
  const keys: string[] = [];
  for (const title of ["one", "two", "three"]) {
    keys.push(
      (
        await call(owner.client, "add_note", {
          product: owner.product,
          title,
          about: [todo.key],
        })
      ).key,
    );
  }
  await call(owner.client, "update_item", {
    item: keys[0],
    status: "archived",
  });
  await call(owner.client, "add_note", {
    product: owner.product,
    title: "not about it",
    about: [other.key],
  });
  await call(hidden.client, "add_note", {
    product: hidden.product,
    title: "out of reach",
    about: [todo.key],
  });
  const scoped = await connect(
    createBot(db, "Paged only", { scope: { products: [owner.product] } }).key,
  );
  const first = await call(scoped, "list_items", { about: todo.key, limit: 2 });
  expect(first.items.map((i: Body) => i.key)).toEqual([keys[2], keys[1]]);
  const rest = await call(scoped, "list_items", {
    about: todo.key,
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(rest.items.map((i: Body) => i.key)).toEqual([keys[0]]);
  expect(rest.nextCursor).toBeNull();
  const keysOf = async (args: Body) =>
    (await call(scoped, "list_items", args)).items.map((i: Body) => i.key);
  expect(
    await keysOf({ about: todo.key, type: "note", status: "archived" }),
  ).toEqual([keys[0]]);
  expect(await keysOf({ about: todo.key, status: "current" })).toEqual([
    keys[2],
    keys[1],
  ]);
});

test("list_items refuses about with a type other than note, a work status, or a key it doesn't reach, naming it", async () => {
  const owner = await productBot("Refuser");
  const hidden = await productBot("Secretive");
  const todo = await call(owner.client, "add_todo", { title: "work" });
  const secret = await call(hidden.client, "add_todo", { title: "secret" });
  const scoped = await connect(
    createBot(db, "Refuser only", { scope: { products: [owner.product] } }).key,
  );
  expect(
    await callError(scoped, "list_items", { about: todo.key, type: "todo" }),
  ).toBe(
    "validation_failed: about lists the notes about an item, so it takes type note or no type, not todo: leave type out, or drop about to list todos",
  );
  expect(
    await callError(scoped, "list_items", { about: todo.key, status: "open" }),
  ).toBe(
    "validation_failed: about lists notes, and a note's status is current or archived, not open",
  );
  for (const key of [secret.key, "ZZ-404"]) {
    expect(await callError(scoped, "list_items", { about: key })).toBe(
      `validation_failed: about names ${key}, which this key doesn't reach or which doesn't exist: send the key, like TRL-12, of an item get_item finds`,
    );
  }
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

test("update_item refuses priority and estimate on a note, or with type note, saying a note has none", async () => {
  const owner = await productBot("Ranker");
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  const todo = await call(owner.client, "add_todo", { title: "work" });
  for (const field of [{ priority: 2 }, { estimate: 3 }, { estimate: null }]) {
    expect(
      await callError(owner.client, "update_item", {
        item: note.key,
        ...field,
      }),
    ).toBe(
      `validation_failed: ${note.key} is a note, and a note has no priority or estimate: leave both out, and file an issue (file_issue) for work someone has to do, listing it in the note's about`,
    );
  }
  expect(
    await callError(owner.client, "update_item", {
      item: todo.key,
      type: "note",
      priority: 1,
    }),
  ).toBe(
    `validation_failed: type note makes ${todo.key} a note, and a note has no priority or estimate: leave both out, and file an issue (file_issue) for work someone has to do, listing it in the note's about`,
  );
  expect(
    await call(owner.client, "get_item", { item: note.key }),
  ).toMatchObject({ priority: 0, estimate: null });
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
  const todo = await call(owner.client, "add_todo", {
    title: "assigned",
    priority: 2,
    estimate: 3,
  });
  for (const item of [issue, todo]) {
    expect(
      await call(owner.client, "update_item", { item: item.key, type: "note" }),
    ).toMatchObject({
      key: item.key,
      type: "note",
      status: "current",
      assignee: null,
      priority: 0,
      estimate: null,
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

test("a note's events go out as trail.item.* with type note, and under the deprecated trail.issue.* names only as the update that made it a note", async () => {
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
    "trail.issue.updated",
    "trail.item.updated",
  ]);
  const created = (
    await call(owner.client, "list_activity", { product: owner.product })
  ).items.find(
    (e: Body) => e.action === "issue.created" && e.payload.key === note.key,
  );
  expect(created.payload).toMatchObject({ type: "note", status: "current" });
});

test("an issue turned into a note sends one last trail.issue.updated carrying type note, and nothing more under trail.issue.*", async () => {
  const owner = await productBot("Retyped");
  const filer = await productBot("Asker");
  const { id } = await call(owner.client, "create_webhook", {
    url: "https://retyped.example.com/hook",
    secret: "whsec_retyped_0123456789",
    products: [owner.product],
  });
  const issue = await call(filer.client, "file_issue", {
    product: owner.product,
    title: "how does export work?",
  });
  await call(owner.client, "update_item", { item: issue.key, type: "note" });
  await call(owner.client, "update_item", {
    item: issue.key,
    title: "how export works",
  });
  await call(owner.client, "add_comment", { item: issue.key, body: "noted" });
  const deliveries = db
    .select({ type: webhookDelivery.type, eventId: webhookDelivery.eventId })
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, id))
    .orderBy(webhookDelivery.seq, webhookDelivery.type)
    .all();
  expect(deliveries.map((d) => d.type)).toEqual([
    "trail.issue.created",
    "trail.item.created",
    "trail.issue.updated",
    "trail.item.updated",
    "trail.item.updated",
    "trail.comment.created",
  ]);
  const conversion = db
    .select()
    .from(activityEvent)
    .where(eq(activityEvent.id, deliveries[2]?.eventId as string))
    .get() as typeof activityEvent.$inferSelect;
  const { data } = buildEnvelope(db, conversion, undefined);
  expect(data.subject).toMatchObject({ key: issue.key, itemType: "note" });
  expect(data.payload).toMatchObject({
    type: { from: "issue", to: "note" },
    status: { from: "triage", to: "current" },
  });
});
