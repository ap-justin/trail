import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  activityEvent,
  apiKey,
  product as productTable,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import { createBot, createKey, revokeKey } from "../service/keys.js";
import { eventForReach } from "../service/visible.js";
import { deliveryReach } from "../service/webhooks.js";
import {
  atFakeTimeAsync,
  projectKey,
  setupTestApp,
  testWebhookSettings,
} from "../test-app.js";
import { buildEnvelope } from "../webhooks/payload.js";
import { createWebhookWorker } from "../webhooks/worker.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bus } = setupTestApp();
const { connect, call, callError } = mcpClients(app);
const sent: { url: string; body: Body }[] = [];
const worker = createWebhookWorker({
  db,
  bus,
  settings: testWebhookSettings({
    transport: async ({ url, body }) => {
      sent.push({ url: url.href, body: JSON.parse(body) });
      return { status: 204 };
    },
  }),
});

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
  const keys = await atFakeTimeAsync(
    Array.from(
      { length: 52 },
      (_, i) => async () =>
        (
          await call(owner.client, "add_note", {
            product: owner.product,
            title: `note ${i}`,
            about: [todo.key],
          })
        ).key,
    ),
  );
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
  const keys = await atFakeTimeAsync(
    ["one", "two", "three"].map(
      (title) => async () =>
        (
          await call(owner.client, "add_note", {
            product: owner.product,
            title,
            about: [todo.key],
          })
        ).key,
    ),
  );
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

test("a note on a product with no owner is edited by its author alone, and a third bot is told only the author edits it", async () => {
  const former = await productBot("Former owner");
  const author = await productBot("Orphan author");
  const third = await productBot("Orphan third");
  const note = await call(author.client, "add_note", {
    product: former.product,
    title: "draft",
  });
  db.update(productTable)
    .set({ ownerId: null })
    .where(eq(productTable.key, former.product))
    .run();
  expect(
    await call(author.client, "update_item", {
      item: note.key,
      title: "by the author",
    }),
  ).toMatchObject({ title: "by the author" });
  expect(
    await callError(third.client, "update_item", {
      item: note.key,
      title: "by a third bot",
    }),
  ).toBe(
    `forbidden: ${note.key} is a note by Orphan author, and only Orphan author edits it: add what you know with add_comment on ${note.key}`,
  );
});

test("add_note with neither product nor project is refused, saying which to send, and writes nothing", async () => {
  const owner = await productBot("Aimless");
  const refusal =
    "validation_failed: add_note needs product: the key (like TRL) of the product the note belongs to, or project: the slug (like launch-q4) of a project drawing from one product; list_products and list_projects list them";
  expect(await callError(owner.client, "add_note", { title: "lost" })).toBe(
    refusal,
  );
  expect(
    await callError(owner.client, "add_note", { title: "lost", product: " " }),
  ).toBe(refusal);
  expect(
    (
      await call(owner.client, "list_items", {
        product: owner.product,
        type: "note",
      })
    ).items,
  ).toEqual([]);
});

test("about naming an item twice is one pointer, and the 50 limit counts the keys as sent", async () => {
  const owner = await productBot("Doubler");
  const todo = await call(owner.client, "add_todo", { title: "pointed at" });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "twice",
    about: [todo.key, todo.key],
  });
  expect(note.about.map((r: Body) => r.key)).toEqual([todo.key]);
  const replaced = await call(owner.client, "update_item", {
    item: note.key,
    about: [todo.key, todo.key, todo.key],
  });
  expect(replaced.about.map((r: Body) => r.key)).toEqual([todo.key]);
  expect(
    (await call(owner.client, "get_item", { item: todo.key })).notesCount,
  ).toEqual({ current: 1, archived: 0 });
  expect(
    await callError(owner.client, "add_note", {
      product: owner.product,
      title: "fifty-one times the same",
      about: Array.from({ length: 51 }, () => todo.key),
    }),
  ).toMatch(/<=50 items at about/);
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
  for (const field of [{ priority: 2 }, { estimate: 3 }]) {
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

test("update_item takes back a note's own priority 0 and estimate null, as get_item shows them, changing nothing", async () => {
  const owner = await productBot("Echoer");
  const [note] = await atFakeTimeAsync([
    () =>
      call(owner.client, "add_note", {
        product: owner.product,
        title: "record",
      }),
  ]);
  const events = async () =>
    (await call(owner.client, "list_activity", { product: owner.product }))
      .items.length;
  const before = await events();
  const echoed = await call(owner.client, "update_item", {
    item: note?.key,
    priority: 0,
    estimate: null,
  });
  expect(echoed).toMatchObject({
    key: note?.key,
    priority: 0,
    estimate: null,
    updatedAt: note?.updatedAt,
  });
  expect(await events()).toBe(before);
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

test("a scoped author replacing about keeps the items its key doesn't reach", async () => {
  const owner = await productBot("Keeper");
  const faraway = await productBot("Faraway keeper");
  const [a, b] = await atFakeTimeAsync([
    () => call(owner.client, "add_todo", { title: "a" }),
    () => call(owner.client, "add_todo", { title: "b" }),
  ]);
  const hidden = await call(faraway.client, "add_todo", { title: "hidden" });
  const scoped = await connect(
    createBot(db, "Keeper only", { scope: { products: [owner.product] } }).key,
  );
  const note = await call(scoped, "add_note", {
    product: owner.product,
    title: "record",
    about: [a?.key],
  });
  await call(owner.client, "update_item", {
    item: note.key,
    addAbout: [hidden.key],
  });
  const replaced = await call(scoped, "update_item", {
    item: note.key,
    about: [b?.key],
  });
  expect(replaced.about.map((r: Body) => r.key)).toEqual([b?.key]);
  const whole = await call(owner.client, "get_item", { item: note.key });
  expect(whole.about.map((r: Body) => r.key).sort()).toEqual(
    [b?.key, hidden.key].sort(),
  );
});

test("an update that leaves about as it is writes nothing: no event, no updatedAt", async () => {
  const owner = await productBot("Stayer");
  const todo = await call(owner.client, "add_todo", { title: "work" });
  const [note] = await atFakeTimeAsync([
    () =>
      call(owner.client, "add_note", {
        product: owner.product,
        title: "record",
        about: [todo.key],
      }),
  ]);
  const events = async () =>
    (await call(owner.client, "list_activity", { product: owner.product }))
      .items.length;
  const before = await events();
  for (const same of [
    { about: [todo.key] },
    { addAbout: [todo.key] },
    { removeAbout: ["ZZ-404"] },
  ]) {
    const read = await call(owner.client, "update_item", {
      item: note?.key,
      ...same,
    });
    expect(read.about.map((r: Body) => r.key)).toEqual([todo.key]);
    expect(read.updatedAt).toBe(note?.updatedAt);
  }
  expect(await events()).toBe(before);
  await call(owner.client, "update_item", {
    item: note?.key,
    removeAbout: [todo.key],
  });
  expect(await events()).toBe(before + 1);
});

test("a note the product's bot wrote itself is edited by it alone: another bot is told only it edits the note", async () => {
  const owner = await productBot("Soloist");
  const other = await productBot("Bystander");
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "mine",
  });
  expect(
    await callError(other.client, "update_item", {
      item: note.key,
      title: "not yours",
    }),
  ).toBe(
    `forbidden: ${note.key} is a note by Soloist, and only Soloist edits it: add what you know with add_comment on ${note.key}`,
  );
});

test("an item turned into a note takes about in the same update", async () => {
  const owner = await productBot("Retyper");
  const target = await call(owner.client, "add_todo", { title: "target" });
  const todo = await call(owner.client, "add_todo", { title: "was work" });
  const turned = await call(owner.client, "update_item", {
    item: todo.key,
    type: "note",
    about: [target.key],
  });
  expect(turned).toMatchObject({ key: todo.key, type: "note" });
  expect(turned.about.map((r: Body) => r.key)).toEqual([target.key]);
  expect(
    (await call(owner.client, "get_item", { item: target.key })).notes.map(
      (n: Body) => n.key,
    ),
  ).toEqual([todo.key]);
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
  const issue = await call(owner.client, "file_issue", {
    product: owner.product,
    title: "work",
  });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  expect(
    (
      await call(owner.client, "list_issues", { product: owner.product })
    ).items.map((i: Body) => i.key),
  ).toEqual([issue.key]);
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

test("a note's events name only the items in its own product it is about, counting the rest in aboutOthers, for activity and webhooks alike", async () => {
  const atlas = await productBot("Atlas follower");
  const boreas = await productBot("Boreas private");
  const todo = await call(atlas.client, "add_todo", { title: "ship export" });
  const secret = await call(boreas.client, "add_todo", { title: "secret" });
  const follower = await connect(
    createBot(db, "Atlas only", { scope: { products: [atlas.product] } }).key,
  );
  const { id } = await call(follower, "create_webhook", {
    url: "https://follower.example.com/hook",
    secret: "whsec_follower_0123456789",
    products: [atlas.product],
  });
  const note = await call(atlas.client, "add_note", {
    product: atlas.product,
    title: "export and the secret share a dialect",
    about: [todo.key, secret.key],
  });
  expect(
    (await call(atlas.client, "get_item", { item: note.key })).about.map(
      (r: Body) => r.key,
    ),
  ).toEqual([todo.key, secret.key].sort());
  await call(atlas.client, "update_item", {
    item: note.key,
    removeAbout: [secret.key],
  });

  const activity = (
    await call(follower, "list_activity", { product: atlas.product })
  ).items.filter((e: Body) => e.subjectId === note.id);
  const payloadOf = (action: string) =>
    activity.find((e: Body) => e.action === action)?.payload;
  expect(payloadOf("issue.created")).toMatchObject({
    about: [todo.key],
    aboutOthers: 1,
  });
  expect(payloadOf("issue.updated")).toEqual({
    about: { from: [todo.key], to: [todo.key] },
    aboutOthers: { from: 1, to: 0 },
  });
  const envelopes = db
    .select()
    .from(webhookDelivery)
    .innerJoin(activityEvent, eq(activityEvent.id, webhookDelivery.eventId))
    .where(eq(webhookDelivery.subscriptionId, id))
    .all()
    .map((d) => buildEnvelope(db, d.activity_event, undefined));
  expect(
    envelopes
      .map((e) => e.data as Body)
      .filter((data) => data.subject.id === note.id)
      .map((data) => data.payload),
  ).toContainEqual(
    expect.objectContaining({ about: [todo.key], aboutOthers: 1 }),
  );
  expect(JSON.stringify([activity, envelopes])).not.toContain(secret.key);

  sent.length = 0;
  await worker.tick();
  const delivered = sent.find(
    (s) =>
      s.url === "https://follower.example.com/hook" &&
      s.body.type === "trail.item.created" &&
      s.body.data.subject.id === note.id,
  );
  expect(delivered?.body.data.payload).toMatchObject({
    about: [todo.key],
    aboutOthers: 1,
  });
});

/** A product with one item in a project and one outside it, and a key that reaches the product only through that project. */
async function noteInProject(name: string) {
  const owner = await productBot(name);
  const slug = `p-${owner.product.toLowerCase()}`;
  const inside = await call(owner.client, "add_todo", { title: "inside" });
  const outside = await call(owner.client, "add_todo", { title: "outside" });
  await call(owner.client, "create_project", {
    name: `${name} launch`,
    slug,
    products: [owner.product],
  });
  await call(owner.client, "add_to_project", {
    project: slug,
    items: [inside.key],
  });
  const follower = await connect(
    createBot(db, `${name} project only`, { scope: { projects: [slug] } }).key,
  );
  return { owner, slug, inside, outside, follower };
}

test("list_activity on a key reaching the note only through a project names only the about items it reaches, counting the rest", async () => {
  const { owner, slug, inside, outside, follower } =
    await noteInProject("Launch");
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    project: slug,
    title: "both todos ship together",
    about: [inside.key, outside.key],
  });
  await call(owner.client, "update_item", {
    item: note.key,
    removeAbout: [inside.key],
  });

  const activity = (await call(follower, "list_activity", {})).items.filter(
    (e: Body) => e.subjectId === note.id,
  );
  const payloadOf = (action: string) =>
    activity.find((e: Body) => e.action === action)?.payload;
  expect(payloadOf("issue.created")).toMatchObject({
    about: [inside.key],
    aboutOthers: 1,
  });
  expect(payloadOf("issue.updated")).toEqual({
    about: { from: [inside.key], to: [] },
    aboutOthers: { from: 1, to: 1 },
  });
  expect(JSON.stringify(activity)).not.toContain(`"${outside.key}"`);
});

test("a webhook following the project on a key reaching only it gets a note's events naming only the about items it reaches, counting the rest", async () => {
  const { owner, slug, inside, outside, follower } =
    await noteInProject("Project hook");
  const url = `https://${slug}.example.com/hook`;
  await call(follower, "create_webhook", {
    url,
    secret: "whsec_project_follower_0123456789",
    projects: [slug],
  });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    project: slug,
    title: "both todos ship together",
    about: [inside.key, outside.key],
  });
  await call(owner.client, "update_item", {
    item: note.key,
    removeAbout: [inside.key],
  });

  sent.length = 0;
  await worker.tick();
  const payloads = sent
    .filter((s) => s.url === url && s.body.data.subject.id === note.id)
    .map((s) => [s.body.type, s.body.data.payload]);
  expect(payloads).toContainEqual([
    "trail.item.created",
    expect.objectContaining({ about: [inside.key], aboutOthers: 1 }),
  ]);
  expect(payloads).toContainEqual([
    "trail.item.updated",
    {
      about: { from: [inside.key], to: [] },
      aboutOthers: { from: 1, to: 1 },
    },
  ]);
  expect(JSON.stringify(payloads)).not.toContain(`"${outside.key}"`);
});

/**
 * A note about two todos of its product, one in a project, and a webhook following that project on a key reaching only it: the key sees the one todo, so the webhook's note event names it and counts the other.
 * `olderKeyActions` sets the bot's older key, which reaches everything.
 */
async function noteSeenByProjectKey(name: string, olderKeyActions?: string[]) {
  const { owner, slug, inside, outside } = await noteInProject(name);
  const follower = createBot(db, `${name} reader`, {
    scope: { actions: olderKeyActions },
  });
  const reading = createKey(db, follower.actor.id, {
    projects: [slug],
    actions: ["read"],
  }).key;
  // minted in one millisecond, the keys' order is the ids': pin the older one first
  for (const [key, at] of [
    [follower.key, 10_000],
    [reading, 20_000],
  ] as const) {
    db.update(apiKey)
      .set({ createdAt: new Date(at) })
      .where(eq(apiKey.prefix, key.slice(6, 14)))
      .run();
  }
  const { id } = await call(await connect(reading), "create_webhook", {
    url: `https://${slug}.example.com/hook`,
    secret: "whsec_reach_0123456789",
    projects: [slug],
  });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    project: slug,
    title: "both todos ship together",
    about: [inside.key, outside.key],
  });
  const event = db
    .select()
    .from(activityEvent)
    .where(
      and(
        eq(activityEvent.subjectId, note.id),
        eq(activityEvent.action, "issue.created"),
      ),
    )
    .get() as typeof activityEvent.$inferSelect;
  const aboutAsSent = () => {
    const sub = db
      .select()
      .from(webhookSubscription)
      .where(eq(webhookSubscription.id, id))
      .get() as typeof webhookSubscription.$inferSelect;
    const { payload } = eventForReach(db, deliveryReach(db, sub, event), event);
    return { about: payload.about, aboutOthers: payload.aboutOthers };
  };
  const forgetRecordedKey = () =>
    db
      .update(webhookSubscription)
      .set({ apiKeyId: null })
      .where(eq(webhookSubscription.id, id))
      .run();
  return { inside, reading, aboutAsSent, forgetRecordedKey };
}

const revoke = (key: string) => revokeKey(db, key.slice(6, 14));

test("a webhook's recorded key decides which about items its note events name, whatever other keys its bot holds", async () => {
  const { inside, aboutAsSent } = await noteSeenByProjectKey("Recorded");
  expect(aboutAsSent()).toEqual({ about: [inside.key], aboutOthers: 1 });
});

test("a webhook recording no key reads a note's about items as its bot's reading keys do, skipping a key that can't read", async () => {
  const { inside, forgetRecordedKey, aboutAsSent } = await noteSeenByProjectKey(
    "Fallback",
    ["comments"],
  );
  forgetRecordedKey();
  expect(aboutAsSent()).toEqual({ about: [inside.key], aboutOthers: 1 });
});

test("a webhook whose recorded key is revoked names no about item of a note and counts them all", async () => {
  const { reading, aboutAsSent } = await noteSeenByProjectKey("Revoked");
  revoke(reading);
  expect(aboutAsSent()).toEqual({ about: [], aboutOthers: 2 });
});

test("a webhook recording no key, whose bot holds no live key that can read, names no about item of a note and counts them all", async () => {
  const { reading, forgetRecordedKey, aboutAsSent } =
    await noteSeenByProjectKey("Keyless", ["comments"]);
  forgetRecordedKey();
  revoke(reading);
  expect(aboutAsSent()).toEqual({ about: [], aboutOthers: 2 });
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

test("a note turned back into a todo or an issue is sent under both trail.issue.* and trail.item.* names, as the item it now is", async () => {
  const owner = await productBot("Reverted");
  const { id } = await call(owner.client, "create_webhook", {
    url: "https://reverted.example.com/hook",
    secret: "whsec_reverted_0123456789",
    products: [owner.product],
  });
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "record",
  });
  await call(owner.client, "update_item", { item: note.key, type: "todo" });
  await call(owner.client, "update_item", {
    item: note.key,
    title: "now work",
  });
  const deliveries = db
    .select({ type: webhookDelivery.type })
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, id))
    .orderBy(webhookDelivery.seq, webhookDelivery.type)
    .all();
  expect(deliveries.map((d) => d.type)).toEqual([
    "trail.item.created",
    "trail.issue.updated",
    "trail.item.updated",
    "trail.issue.updated",
    "trail.item.updated",
  ]);
});

test("an update that would make a note about more than 50 items is refused, naming the total, and leaves about as it was", async () => {
  const owner = await productBot("Capper");
  const todos: string[] = [];
  for (let i = 0; i < 60; i++) {
    todos.push(
      (await call(owner.client, "add_todo", { title: `item ${i}` })).key,
    );
  }
  const note = await call(owner.client, "add_note", {
    product: owner.product,
    title: "wide record",
    about: todos.slice(0, 30),
  });
  expect(
    await callError(owner.client, "update_item", {
      item: note.key,
      addAbout: todos.slice(30, 60),
    }),
  ).toBe(
    "validation_failed: a note is about at most 50 items, and this update would make it about 60: drop some with removeAbout",
  );
  expect(
    (await call(owner.client, "get_item", { item: note.key })).about,
  ).toHaveLength(30);
  // 30 + 20 is exactly the cap: the same call, one short of refused
  expect(
    (
      await call(owner.client, "update_item", {
        item: note.key,
        addAbout: todos.slice(30, 50),
      })
    ).about,
  ).toHaveLength(50);
});

test("a key scoped to one product can't add a note to another, and no note appears there", async () => {
  const mine = await productBot("Mine");
  const theirs = await productBot("Theirs");
  const scoped = await connect(
    createBot(db, "Mine only", { scope: { products: [mine.product] } }).key,
  );
  expect(
    await call(scoped, "add_note", { product: mine.product, title: "ok" }),
  ).toMatchObject({ type: "note" });
  expect(
    await callError(scoped, "add_note", {
      product: theirs.product,
      title: "not here",
    }),
  ).toBe(
    `not_found: no product ${theirs.product}: pass the key (like TRL) of a product this key reaches; list_products (GET /api/v1/products) lists them`,
  );
  expect(
    (
      await call(theirs.client, "list_items", {
        product: theirs.product,
        type: "note",
      })
    ).items,
  ).toEqual([]);
});

test("a third bot can't archive a note or change what it is about, and its comment is on the note", async () => {
  const owner = await productBot("Binder");
  const author = await productBot("Scribe two");
  const third = await productBot("Meddler");
  const target = await call(owner.client, "add_todo", { title: "target" });
  const other = await call(owner.client, "add_todo", { title: "other" });
  const note = await call(author.client, "add_note", {
    product: owner.product,
    title: "kept",
    about: [target.key],
  });
  const refused = `forbidden: ${note.key} is a note by Scribe two, and only Scribe two and Binder, the bot of ${owner.product}, edit it: add what you know with add_comment on ${note.key}`;
  for (const patch of [
    { status: "archived" },
    { about: [other.key] },
    { addAbout: [other.key] },
    { removeAbout: [target.key] },
  ]) {
    expect(
      await callError(third.client, "update_item", {
        item: note.key,
        ...patch,
      }),
    ).toBe(refused);
  }
  await call(third.client, "add_comment", { item: note.key, body: "also" });
  const read = await call(owner.client, "get_item", { item: note.key });
  expect(read).toMatchObject({
    status: "current",
    about: [{ key: target.key }],
  });
  const comments = (
    await call(owner.client, "list_comments", { item: note.key })
  ).items;
  expect(comments.map((c: Body) => c.body)).toEqual(["also"]);
});

test("the owner turns an archived note into a todo or an issue, which leaves the archive and drops about", async () => {
  const owner = await productBot("Reviver");
  const target = await call(owner.client, "add_todo", { title: "target" });
  const archivedNote = async (title: string) => {
    const note = await call(owner.client, "add_note", {
      product: owner.product,
      title,
      about: [target.key],
    });
    await call(owner.client, "update_item", {
      item: note.key,
      status: "archived",
    });
    return note;
  };
  const toTodo = await archivedNote("last quarter's todo");
  const toIssue = await archivedNote("last quarter's issue");
  const todo = await call(owner.client, "update_item", {
    item: toTodo.key,
    type: "todo",
  });
  expect(todo).toMatchObject({
    type: "todo",
    status: "open",
    assignee: { name: "Reviver" },
  });
  expect(todo.about).toBeUndefined();
  expect(
    await call(owner.client, "update_item", {
      item: toIssue.key,
      type: "issue",
    }),
  ).toMatchObject({ type: "issue", status: "triage", assignee: null });
  expect(
    (await call(owner.client, "get_item", { item: target.key })).notesCount,
  ).toEqual({ current: 0, archived: 0 });
});

test("the owner turns a note into an issue or a todo with the status it names", async () => {
  const owner = await productBot("Acceptor");
  const note = (title: string) =>
    call(owner.client, "add_note", { product: owner.product, title });
  const [toOpenIssue, toDoneTodo] = [await note("one"), await note("two")];
  expect(
    await call(owner.client, "update_item", {
      item: toOpenIssue.key,
      type: "issue",
      status: "open",
    }),
  ).toMatchObject({ type: "issue", status: "open" });
  expect(
    await call(owner.client, "update_item", {
      item: toDoneTodo.key,
      type: "todo",
      status: "in_progress",
    }),
  ).toMatchObject({ type: "todo", status: "in_progress" });
});
