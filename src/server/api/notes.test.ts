import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { activityEventSchema } from "../../shared/schemas.js";
import { activityEvent, webhookDelivery } from "../db/schema.js";
import { createBot, createKey } from "../service/keys.js";
import { eventForReach, type Reach } from "../service/visible.js";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";

const { bot, addBot, db, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

/** A product created over REST by `key`'s bot, which owns it. */
async function newProduct(name: string, key = bot.key) {
  const res = await request("POST", "/api/v1/products", {
    json: { key: projectKey(), name },
    key,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Body;
}

async function ok(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as Body;
}

test("REST mirrors add_note: POST /items with type note on another bot's product, PATCH about and status, GET /items with type note", async () => {
  const owner = await newProduct("rest notes");
  const writer = addBot("rest writer");
  const todo = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: owner.key, title: "work" },
    }),
    201,
  );
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: {
        type: "note",
        product: owner.key,
        title: "record",
        about: [todo.key],
      },
      key: writer.key,
    }),
    201,
  );
  expect(note).toMatchObject({
    type: "note",
    status: "current",
    assignee: null,
    about: [{ key: todo.key, type: "todo" }],
  });
  expect(
    await ok(
      await request("PATCH", `/api/v1/items/${note.key}`, {
        json: { status: "archived", removeAbout: [todo.key] },
        key: writer.key,
      }),
    ),
  ).toMatchObject({ status: "archived", about: [] });
  const listed = await ok(
    await request(
      "GET",
      `/api/v1/items?product=${owner.key}&type=note&status=archived`,
    ),
  );
  expect(listed.items.map((i: Body) => i.key)).toEqual([note.key]);
  expect(
    (
      await ok(await request("GET", `/api/v1/items?product=${owner.key}`))
    ).items.map((i: Body) => i.key),
  ).toEqual([todo.key]);
  expect(
    (await ok(await request("GET", `/api/v1/products/${owner.key}`))).notes,
  ).toEqual({ current: 0, archived: 1 });
});

test.each([
  ["a todo", "todo"],
  ["an issue", "issue"],
])("POST /items refuses about on %s, naming the rule", async (_, type) => {
  const owner = await newProduct(`rest about ${type}`);
  const res = await request("POST", "/api/v1/items", {
    json: { type, product: owner.key, title: "ask", about: [] },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^about is a note's field.*add a note about the item with add_note/,
  );
});

test("POST /items refuses an assignee on a note", async () => {
  const owner = await newProduct("rest refusals");
  const note = await request("POST", "/api/v1/items", {
    json: {
      type: "note",
      product: owner.key,
      title: "record",
      assignee: "tester",
    },
  });
  expect(note.status).toBe(422);
  expect(((await note.json()) as Body).error.message).toMatch(
    /^a note has no assignee/,
  );
});

test.each([
  ["priority", { priority: 2 }],
  ["estimate", { estimate: 3 }],
])("POST /items refuses %s on a note", async (_, field) => {
  const owner = await newProduct("rest unranked");
  const note = await request("POST", "/api/v1/items", {
    json: { type: "note", product: owner.key, title: "record", ...field },
  });
  expect(note.status).toBe(422);
  expect(((await note.json()) as Body).error.message).toBe(
    "a note has no priority or estimate, since nobody has to act on it: leave both out, and file an issue (file_issue) for work someone has to do, listing it in the note's about",
  );
});

test("POST /items takes priority 0 on a note, the priority a note holds", async () => {
  const owner = await newProduct("rest unranked echo");
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "note", product: owner.key, title: "record", priority: 0 },
    }),
    201,
  );
  expect(note).toMatchObject({ type: "note", priority: 0, estimate: null });
});

test("PATCH /items/{key} with type note and estimate null turns an issue into a note, and still refuses a nonzero priority", async () => {
  const owner = await newProduct("rest convert clear");
  const issue = await ok(
    await request("POST", "/api/v1/items", {
      json: {
        type: "issue",
        product: owner.key,
        title: "is this a bug?",
        priority: 2,
        estimate: 3,
      },
    }),
    201,
  );
  const refused = await request("PATCH", `/api/v1/items/${issue.key}`, {
    json: { type: "note", priority: 2 },
  });
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as Body).error.message).toBe(
    `type note makes ${issue.key} a note, and a note has no priority or estimate: leave both out, and file an issue (file_issue) for work someone has to do, listing it in the note's about`,
  );
  expect(
    await ok(
      await request("PATCH", `/api/v1/items/${issue.key}`, {
        json: { type: "note", estimate: null },
      }),
    ),
  ).toMatchObject({ type: "note", priority: 0, estimate: null });
});

test("GET /items/{key} counts the notes about an item in notesCount, and GET /items?about= lists them, refusing a type other than note", async () => {
  const owner = await newProduct("rest about list");
  const todo = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: owner.key, title: "work" },
    }),
    201,
  );
  const notes = await atFakeTimeAsync(
    ["older", "newer"].map(
      (title) => async () =>
        ok(
          await request("POST", "/api/v1/items", {
            json: {
              type: "note",
              product: owner.key,
              title,
              about: [todo.key],
            },
          }),
          201,
        ),
    ),
  );
  await ok(
    await request("PATCH", `/api/v1/items/${notes[0]?.key}`, {
      json: { status: "archived" },
    }),
  );
  const read = await ok(await request("GET", `/api/v1/items/${todo.key}`));
  expect(read.notes.map((n: Body) => n.key)).toEqual([notes[1]?.key]);
  expect(read.notesCount).toEqual({ current: 1, archived: 1 });
  const listed = await ok(
    await request("GET", `/api/v1/items?about=${todo.key}`),
  );
  expect(listed.items.map((i: Body) => i.key)).toEqual([
    notes[1]?.key,
    notes[0]?.key,
  ]);
  const refused = await request(
    "GET",
    `/api/v1/items?about=${todo.key}&type=issue`,
  );
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as Body).error.message).toMatch(
    /^about lists the notes about an item, so it takes type note or no type, not issue/,
  );
});

test("the deprecated /issues routes never show a note", async () => {
  const owner = await newProduct("rest legacy");
  const issue = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "issue", product: owner.key, title: "work" },
    }),
    201,
  );
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "note", product: owner.key, title: "record" },
    }),
    201,
  );
  expect(
    (
      await ok(await request("GET", `/api/v1/issues?product=${owner.key}`))
    ).items.map((i: Body) => i.key),
  ).toEqual([issue.key]);
  const read = await request("GET", `/api/v1/issues/${note.key}`);
  expect(read.status).toBe(404);
  expect(((await read.json()) as Body).error.message).toBe(
    `${note.key} is a note, which the deprecated issue routes don't serve: read it with get_item (GET /api/v1/items/{key}) and edit it with update_item (PATCH /api/v1/items/{key})`,
  );
  const edit = await request("PATCH", `/api/v1/issues/${note.key}`, {
    json: { title: "x" },
  });
  expect(edit.status).toBe(404);
  expect(((await edit.json()) as Body).error.message).toMatch(
    new RegExp(`^${note.key} is a note, `),
  );
});

test("the OpenAPI spec documents notes on the items routes", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as Body;
  const schemas = spec.components.schemas;
  expect(schemas.ItemType.enum).toEqual(["issue", "todo", "note"]);
  expect(Object.keys(schemas.ItemCreate.properties)).toContain("about");
  expect(Object.keys(schemas.ItemUpdate.properties)).toEqual(
    expect.arrayContaining(["about", "addAbout", "removeAbout"]),
  );
  expect(schemas.Item.properties.notes).toBeDefined();
  expect(schemas.Item.properties.notesCount).toBeDefined();
  expect(schemas.Project.properties.notes).toBeDefined();
  expect(
    spec.paths["/items"].get.parameters.map((p: Body) => p.name),
  ).toContain("about");
  expect(spec.paths["/items"].post.description).toMatch(
    /a note is a record nobody has to act on/,
  );
  const patch = spec.paths["/items/{key}"].patch;
  expect(patch.summary).toMatch(/the items a note is about/);
  expect(patch.responses["403"].description).toMatch(
    /the item is a note and the key's bot is neither its author nor the product's owner/,
  );
  const payload = schemas.ActivityEvent.properties.payload;
  expect(Object.keys(payload.properties)).toEqual(["about", "aboutOthers"]);
  expect(payload.additionalProperties).not.toBe(false);
});

test("a note's created event lists the keys it is about, as its updated event does", async () => {
  const owner = await newProduct("created about");
  const writer = addBot("created about writer");
  const todo = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: owner.key, title: "work" },
    }),
    201,
  );
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: {
        type: "note",
        product: owner.key,
        title: "record",
        about: [todo.key],
      },
      key: writer.key,
    }),
    201,
  );
  await ok(
    await request("PATCH", `/api/v1/items/${note.key}`, {
      json: { about: [] },
      key: writer.key,
    }),
  );
  const events = (
    await ok(
      await request(
        "GET",
        `/api/v1/activity?actorId=${writer.actor.id}&limit=200`,
      ),
    )
  ).items.filter((e: Body) => e.subjectId === note.id);
  const payloadOf = (action: string) =>
    events.find((e: Body) => e.action === action)?.payload;
  expect(payloadOf("issue.created")).toMatchObject({
    key: note.key,
    type: "note",
    about: [todo.key],
  });
  expect(payloadOf("issue.updated").about).toEqual({
    from: [todo.key],
    to: [],
  });
});

test("GET /activity for a key reaching only the note's product names its own-product about keys and counts the rest, through the note's turn into an issue", async () => {
  const owner = await newProduct("activity about");
  const elsewhere = addBot("elsewhere owner");
  const hidden = await newProduct("hidden about", elsewhere.key);
  const todo = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: owner.key, title: "work" },
    }),
    201,
  );
  const secret = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: hidden.key, title: "secret" },
      key: elsewhere.key,
    }),
    201,
  );
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: {
        type: "note",
        product: owner.key,
        title: "record",
        about: [todo.key, secret.key],
      },
    }),
    201,
  );
  await ok(
    await request("PATCH", `/api/v1/items/${note.key}`, {
      json: { type: "issue" },
    }),
  );
  const follower = createBot(db, "activity follower", {
    scope: { products: [owner.key] },
  });
  const events = (
    await ok(
      await request("GET", `/api/v1/activity?product=${owner.key}`, {
        key: follower.key,
      }),
    )
  ).items.filter((e: Body) => e.subjectId === note.id);
  const payloadOf = (action: string) =>
    events.find((e: Body) => e.action === action)?.payload;
  expect(payloadOf("issue.created")).toMatchObject({
    about: [todo.key],
    aboutOthers: 1,
  });
  expect(payloadOf("issue.updated")).toMatchObject({
    type: { from: "note", to: "issue" },
    about: { from: [todo.key], to: [] },
    aboutOthers: { from: 1, to: 0 },
  });
  expect(JSON.stringify(events)).not.toContain(secret.key);
  for (const event of events) {
    expect(activityEventSchema.safeParse(event).error).toBeUndefined();
  }
});

test("a note event read by a key reaching the note's product is returned as stored, without a statement", async () => {
  const owner = await newProduct("about own product");
  const todo = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: owner.key, title: "work" },
    }),
    201,
  );
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: {
        type: "note",
        product: owner.key,
        title: "record",
        about: [todo.key],
      },
    }),
    201,
  );
  const event = db
    .select()
    .from(activityEvent)
    .where(eq(activityEvent.subjectId, note.id))
    .get();
  if (!event) throw new Error("no event for the note");
  const statementsOf = (reach: Reach) => {
    const prepare = vi.spyOn(db.$client, "prepare");
    try {
      return {
        read: eventForReach(db, reach, event),
        statements: prepare.mock.calls.length,
      };
    } finally {
      prepare.mockRestore();
    }
  };

  const byProduct = statementsOf({
    products: [event.productId as string],
    projects: [],
    implicitProjects: true,
  });
  expect(byProduct.read).toBe(event);
  expect(byProduct.statements).toBe(0);
  // a key reaching the product only through a project still has its keys looked up
  expect(
    statementsOf({
      products: [],
      projects: ["no-project"],
      implicitProjects: true,
    }).statements,
  ).toBeGreaterThan(0);
});

test("PATCH /items/{key} on a note by a third bot is 403 forbidden, and the note stays as written", async () => {
  const owner = await newProduct("rest authz");
  const author = addBot("rest author");
  const third = addBot("rest third");
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "note", product: owner.key, title: "draft" },
      key: author.key,
    }),
    201,
  );
  const res = await request("PATCH", `/api/v1/items/${note.key}`, {
    json: { title: "by a third bot" },
    key: third.key,
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as Body).error).toMatchObject({
    code: "forbidden",
    message: expect.stringContaining(`add what you know with add_comment`),
  });
  const read = await ok(await request("GET", `/api/v1/items/${note.key}`));
  expect(read.title).toBe("draft");
});

test("POST /items with type note needs a key with the issues action, and a key at all", async () => {
  const owner = await newProduct("rest keys");
  const readOnly = createBot(db, "rest reader", {
    scope: { actions: ["read"] },
  });
  const note = { type: "note", product: owner.key, title: "record" };
  const denied = await request("POST", "/api/v1/items", {
    json: note,
    key: readOnly.key,
  });
  expect(denied.status).toBe(403);
  expect(((await denied.json()) as Body).error.code).toBe("forbidden_action");
  const anonymous = await request("POST", "/api/v1/items", {
    json: note,
    key: null,
  });
  expect(anonymous.status).toBe(401);
  expect(
    (
      await ok(
        await request("GET", `/api/v1/items?product=${owner.key}&type=note`),
      )
    ).items,
  ).toEqual([]);
});

test("PATCH /items/{key} refuses about with 51 items and an addAbout that would make 51, leaving the note as it was", async () => {
  const owner = await newProduct("rest cap");
  const keys: string[] = [];
  for (let i = 0; i < 51; i++) {
    keys.push(
      (
        await ok(
          await request("POST", "/api/v1/items", {
            json: { type: "todo", product: owner.key, title: `item ${i}` },
          }),
          201,
        )
      ).key,
    );
  }
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: {
        type: "note",
        product: owner.key,
        title: "wide",
        about: keys.slice(0, 50),
      },
    }),
    201,
  );
  expect(note.about).toHaveLength(50);
  for (const patch of [{ about: keys }, { addAbout: [keys[50]] }]) {
    const res = await request("PATCH", `/api/v1/items/${note.key}`, {
      json: patch,
    });
    expect(res.status, await res.clone().text()).toBe(422);
    expect(((await res.json()) as Body).error.code).toBe("validation_failed");
  }
  const read = await ok(await request("GET", `/api/v1/items/${note.key}`));
  expect(read.about.map((r: Body) => r.key).sort()).toEqual(
    keys.slice(0, 50).sort(),
  );
});

test("a refused PATCH turning an item into a note leaves its type, fields, events and webhook deliveries as they were", async () => {
  const owner = await newProduct("rest atomic");
  const elsewhere = addBot("rest atomic elsewhere");
  const hiddenProduct = await newProduct("rest atomic hidden", elsewhere.key);
  const create = async (product: string, title: string, key?: string) =>
    ok(
      await request("POST", "/api/v1/items", {
        json: { type: "todo", product, title, priority: 2, estimate: 3 },
        key,
      }),
      201,
    );
  const hidden = await create(hiddenProduct.key, "hidden", elsewhere.key);
  const target = await create(owner.key, "target");
  const todo = await create(owner.key, "work");
  const reaching = createKey(db, bot.actor.id, { products: [owner.key] }).key;
  const hook = await ok(
    await request("POST", "/api/v1/webhooks", {
      json: {
        url: "https://rest-atomic.example.com/hook",
        secret: "whsec_rest_atomic_0123456789",
        products: [owner.key],
      },
    }),
    201,
  );
  const state = async () => ({
    item: await ok(await request("GET", `/api/v1/items/${todo.key}`)),
    events: (
      await ok(await request("GET", `/api/v1/activity?product=${owner.key}`))
    ).items.length,
    deliveries: db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, hook.id))
      .all().length,
  });
  const before = await state();

  for (const [key, patch] of [
    [reaching, { about: [hidden.key] }],
    [bot.key, { about: Array.from({ length: 51 }, () => target.key) }],
    [bot.key, { status: "done" }],
  ] as const) {
    const res = await request("PATCH", `/api/v1/items/${todo.key}`, {
      json: { type: "note", title: "retitled", ...patch },
      key,
    });
    expect(res.status, await res.clone().text()).toBe(422);
    expect(await state()).toEqual(before);
  }

  // the same retype with a reachable about is written: the state above can move
  expect(
    await ok(
      await request("PATCH", `/api/v1/items/${todo.key}`, {
        json: { type: "note", title: "retitled", about: [target.key] },
      }),
    ),
  ).toMatchObject({ type: "note", title: "retitled" });
  const after = await state();
  expect(after.events).toBe(before.events + 1);
  expect(after.deliveries).toBeGreaterThan(before.deliveries);
});
