import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

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

test("the deprecated /issues routes never show a note", async () => {
  const owner = await newProduct("rest legacy");
  const note = await ok(
    await request("POST", "/api/v1/items", {
      json: { type: "note", product: owner.key, title: "record" },
    }),
    201,
  );
  expect(
    (await ok(await request("GET", `/api/v1/issues?product=${owner.key}`)))
      .items,
  ).toEqual([]);
  expect((await request("GET", `/api/v1/issues/${note.key}`)).status).toBe(404);
  expect(
    (
      await request("PATCH", `/api/v1/issues/${note.key}`, {
        json: { title: "x" },
      })
    ).status,
  ).toBe(404);
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
  expect(schemas.Project.properties.notes).toBeDefined();
  expect(spec.paths["/items"].post.description).toMatch(
    /a note is a record nobody has to act on/,
  );
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
