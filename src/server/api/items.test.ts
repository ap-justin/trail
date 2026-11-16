import { beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";

const { db, bot, addBot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const tester = { id: bot.actor.id, name: "tester", kind: "bot" };

/** A product created by `key`'s bot over REST, which that bot owns. */
async function newProduct(name: string, key = bot.key) {
  const res = await request("POST", "/api/v1/products", {
    json: { key: projectKey(), name },
    key,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Body;
}

let own: Body;
beforeAll(async () => {
  own = await newProduct("items");
});

async function createItem(json: Record<string, unknown>, key = bot.key) {
  const res = await request("POST", "/api/v1/items", { json, key });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json()) as Body;
}

test("POST /items adds a todo, open and assigned to the product's owner", async () => {
  const res = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: own.key, title: "first" },
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    id: expect.any(String),
    key: `${own.key}-1`,
    number: 1,
    type: "todo",
    product: own.key,
    project: own.key,
    projects: [],
    projectId: own.id,
    title: "first",
    description: "",
    status: "open",
    priority: 0,
    estimate: null,
    labels: [],
    links: [],
    assignee: tester,
    assigneeId: bot.actor.id,
    externalRef: null,
    sourceAuthor: null,
    sourceStatus: null,
    sourceKey: null,
    createdBy: bot.actor.id,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    completedAt: null,
  });
});

test("a todo without product goes to the caller's one own product", async () => {
  const solo = addBot("solo owner");
  const mine = await newProduct("solo", solo.key);
  const todo = await createItem({ type: "todo", title: "mine" }, solo.key);
  expect(todo).toMatchObject({ product: mine.key, assigneeId: solo.actor.id });
});

test("a todo without product is a 422 naming the products to pick from", async () => {
  const many = addBot("many owner");
  const [a, b] = [
    await newProduct("one", many.key),
    await newProduct("two", many.key),
  ];
  const several = await request("POST", "/api/v1/items", {
    json: { type: "todo", title: "where?" },
    key: many.key,
  });
  expect(several.status).toBe(422);
  const keys = [a.key, b.key].sort();
  expect(((await several.json()) as Body).error.message).toBe(
    `you own 2 products, so add_todo needs product: pick one of ${keys[0]} and ${keys[1]}`,
  );

  const scoped = createBot(db, "owns nothing", {
    scope: { projects: [own.key] },
  });
  const none = await request("POST", "/api/v1/items", {
    json: { type: "todo", title: "where?" },
    key: scoped.key,
  });
  expect(none.status).toBe(422);
  expect(((await none.json()) as Body).error.message).toBe(
    `you own no product, so add_todo needs product: pick one of ${own.key} (list_products describes each)`,
  );
});

test("POST /items files an issue on another bot's product: in triage, unassigned", async () => {
  const other = addBot("reporter");
  const issue = await createItem(
    { type: "issue", product: own.key, title: "it broke" },
    other.key,
  );
  expect(issue).toMatchObject({
    type: "issue",
    status: "triage",
    assignee: null,
    createdBy: other.actor.id,
  });
});

test("a todo in another bot's product is a 403 naming its owner and saying to file an issue", async () => {
  const other = addBot("todo outsider");
  const res = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: own.key, title: "not mine to plan" },
    key: other.key,
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as Body).error).toEqual({
    code: "forbidden",
    message: `${own.key} is owned by tester, so only tester adds its todos: file the work as an issue with file_issue (POST /items with type issue), and tester accepts it from triage`,
  });
});

test("PATCH /items/:key by a bot that doesn't own the product can't accept, cancel or retype a triage issue, and changes nothing", async () => {
  const filer = addBot("triage filer");
  const outsider = addBot("triage outsider");
  const { key } = await createItem(
    { type: "issue", product: own.key, title: "owner decides" },
    filer.key,
  );
  for (const json of [{ status: "open" }, { type: "todo" }]) {
    const res = await request("PATCH", `/api/v1/items/${key}`, {
      json,
      key: outsider.key,
    });
    expect(res.status, JSON.stringify(json)).toBe(403);
    expect(((await res.json()) as Body).error.code).toBe("forbidden");
  }
  const after = await request("GET", `/api/v1/items/${key}`);
  expect(await after.json()).toMatchObject({ type: "issue", status: "triage" });
});

test("an issue on a product the key doesn't reach is the 404 an unknown one is", async () => {
  const elsewhere = await newProduct("elsewhere");
  const scoped = createBot(db, "scoped filer", {
    scope: { projects: [own.key] },
  });
  const hidden = await request("POST", "/api/v1/items", {
    json: { type: "issue", product: elsewhere.key, title: "x" },
    key: scoped.key,
  });
  const unknown = await request("POST", "/api/v1/items", {
    json: { type: "issue", product: "NOPE", title: "x" },
    key: scoped.key,
  });
  expect(hidden.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(((await hidden.json()) as Body).error.message).toBe(
    `no product ${elsewhere.key}: pass the key (like TRL) of a product this key reaches; list_products (GET /api/v1/products) lists them`,
  );
});

test("an issue needs product", async () => {
  const res = await request("POST", "/api/v1/items", {
    json: { type: "issue", title: "nowhere" },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^file_issue needs product/,
  );
});

test("PATCH /items/:key accepts an issue from triage, assigns by name and unassigns", async () => {
  const { key } = await createItem({
    type: "issue",
    product: own.key,
    title: "triage me",
  });
  const accepted = await request("PATCH", `/api/v1/items/${key}`, {
    json: { status: "open", assignee: "TESTER" },
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    status: "open",
    assignee: tester,
  });
  const done = await request("PATCH", `/api/v1/items/${key}`, {
    json: { status: "done", assignee: null },
  });
  expect(await done.json()).toMatchObject({
    status: "done",
    assignee: null,
    completedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
  });
});

test("type todo on an issue in triage opens it and assigns it to the owner", async () => {
  const other = addBot("convert reporter");
  const { key } = await createItem(
    { type: "issue", product: own.key, title: "make it mine" },
    other.key,
  );
  const res = await request("PATCH", `/api/v1/items/${key}`, {
    json: { type: "todo" },
  });
  expect(await res.json()).toMatchObject({
    type: "todo",
    status: "open",
    assigneeId: bot.actor.id,
  });
});

test("a todo is never in triage and never unassigned", async () => {
  const { key } = await createItem({
    type: "todo",
    product: own.key,
    title: "planned",
  });
  const triage = await request("PATCH", `/api/v1/items/${key}`, {
    json: { status: "triage" },
  });
  expect(triage.status).toBe(422);
  expect(((await triage.json()) as Body).error.message).toBe(
    `${key} is a todo, and a todo is never in triage: send status open to accept it, or type issue to make it an issue first`,
  );
  const unassigned = await request("PATCH", `/api/v1/items/${key}`, {
    json: { assignee: null },
  });
  expect(unassigned.status).toBe(422);
  expect(((await unassigned.json()) as Body).error.message).toMatch(
    /a todo always has an assignee: assign it to another bot, or send type issue/,
  );
  const created = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: own.key, title: "x", assignee: null },
  });
  expect(created.status).toBe(422);
});

test("PATCH /items/:key with an unknown status is a 422 and changes nothing", async () => {
  const { key } = await createItem({
    type: "todo",
    product: own.key,
    title: "stay open",
  });
  const res = await request("PATCH", `/api/v1/items/${key}`, {
    json: { status: "closed" },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(/^status: /);
  const after = await request("GET", `/api/v1/items/${key}`);
  expect(((await after.json()) as Body).status).toBe("open");
});

test("assigning an unknown actor is a 422 saying where names come from", async () => {
  const { key } = await createItem({
    type: "issue",
    product: own.key,
    title: "nobody",
  });
  const res = await request("PATCH", `/api/v1/items/${key}`, {
    json: { assignee: "ghost" },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toBe(
    "no bot or person ghost to assign: pass a bot's name or id (list_bots lists them) or a person's id",
  );
});

test("GET /items/:key finds an item; an unknown key is a 404 naming list_items", async () => {
  const { key } = await createItem({
    type: "todo",
    product: own.key,
    title: "fetch me",
  });
  const res = await request("GET", `/api/v1/items/${key.toLowerCase()}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ key, title: "fetch me" });
  const missing = await request("GET", "/api/v1/items/NOPE-1");
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as Body).error.message).toMatch(/list_items/);
});

test("GET /items filters by product, type, status and assignee", async () => {
  const filters = await newProduct("filters");
  const other = addBot("filter reporter");
  await atFakeTimeAsync([
    () => createItem({ type: "todo", product: filters.key, title: "f-todo" }),
    () =>
      createItem(
        { type: "issue", product: filters.key, title: "f-issue" },
        other.key,
      ),
    () =>
      createItem({
        type: "todo",
        product: filters.key,
        title: "f-theirs",
        assignee: other.actor.id,
      }),
  ]);
  const titles = async (query: string) => {
    const res = await request(
      "GET",
      `/api/v1/items?product=${filters.key}&${query}`,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as Body).items.map((i: Body) => i.title);
  };
  expect(await titles("")).toEqual(["f-theirs", "f-issue", "f-todo"]);
  expect(await titles("type=issue")).toEqual(["f-issue"]);
  expect(await titles("status=triage")).toEqual(["f-issue"]);
  expect(await titles("type=todo&status=open")).toEqual(["f-theirs", "f-todo"]);
  expect(await titles("assignee=filter%20reporter")).toEqual(["f-theirs"]);
  expect(await titles(`assignee=${bot.actor.id}`)).toEqual(["f-todo"]);
});

test("GET /items?status=closed is a 422", async () => {
  const res = await request("GET", "/api/v1/items?status=closed");
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(/^status: /);
});

type ItemPage = { items: Body[]; nextCursor: string | null };

async function itemPage(query: string) {
  const res = await request("GET", `/api/v1/items?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ItemPage;
}

test("GET /items pages through nextCursor without repeats", async () => {
  const paging = await newProduct("paging");
  await atFakeTimeAsync(
    ["p1", "p2", "p3"].map(
      (title) => () => createItem({ type: "todo", product: paging.key, title }),
    ),
  );
  const first = await itemPage(`product=${paging.key}&limit=2`);
  expect(first.items.map((i) => i.title)).toEqual(["p3", "p2"]);
  const second = await itemPage(
    `product=${paging.key}&limit=2&cursor=${first.nextCursor}`,
  );
  expect(second.items.map((i) => i.title)).toEqual(["p1"]);
  expect(second.nextCursor).toBeNull();
});

test("GET /items on a product with no items is one empty page", async () => {
  const empty = await newProduct("empty");
  expect(await itemPage(`product=${empty.key}`)).toEqual({
    items: [],
    nextCursor: null,
  });
});

test("GET /items refuses limit 0 and 201 with a 422", async () => {
  for (const limit of [0, 201]) {
    const res = await request("GET", `/api/v1/items?limit=${limit}`);
    expect(res.status, `limit ${limit}`).toBe(422);
  }
});

test("a repeated create with the same Idempotency-Key returns the first item", async () => {
  const headers = { "idempotency-key": "items-once" };
  const first = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: own.key, title: "once" },
    headers,
  });
  const again = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: own.key, title: "once" },
    headers,
  });
  expect(first.status).toBe(201);
  expect(await again.json()).toEqual(await first.json());
  const reused = await request("POST", "/api/v1/items", {
    json: { type: "issue", product: own.key, title: "once" },
    headers,
  });
  expect(reused.status).toBe(422);
  expect(((await reused.json()) as Body).error.code).toBe(
    "idempotency_key_reused",
  );
});

test("a field sent under its old name is a 422 naming the field it became", async () => {
  const cases = [
    [
      "POST",
      "/api/v1/items",
      { type: "todo", projectId: own.key, title: "old field" },
      'Unrecognized key "projectId": it is product now, so send product instead',
    ],
    [
      "POST",
      "/api/v1/items",
      { type: "todo", product: own.key, title: "old", assigneeId: null },
      'Unrecognized key "assigneeId": it is assignee now, so send assignee instead',
    ],
    [
      "PATCH",
      `/api/v1/items/${own.key}-1`,
      { assigneeId: "tester" },
      'Unrecognized key "assigneeId": it is assignee now, so send assignee instead',
    ],
    [
      "PATCH",
      `/api/v1/issues/${own.key}-1`,
      { assignee: "tester" },
      'Unrecognized key "assignee": on this deprecated route it is assigneeId, so send assigneeId, or use PATCH /items/{key} (update_item), which takes assignee',
    ],
  ] as const;
  for (const [method, path, json, message] of cases) {
    const res = await request(method, path, { json });
    expect(res.status, `${method} ${path}`).toBe(422);
    expect(((await res.json()) as Body).error.message).toBe(message);
  }
  const unknown = await request("PATCH", `/api/v1/items/${own.key}-1`, {
    json: { colour: "red" },
  });
  expect(((await unknown.json()) as Body).error.message).toBe(
    'Unrecognized key: "colour"',
  );
});
