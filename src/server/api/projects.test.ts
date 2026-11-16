import { beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, bot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const json = async (res: Response) => (await res.json()) as Body;

let mine: Body;
let other: { key: string; product: Body };
beforeAll(async () => {
  mine = await json(
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "mine" },
    }),
  );
  const otherBot = createBot(db, "rest project neighbour");
  other = {
    key: otherBot.key,
    product: await json(
      await request("POST", "/api/v1/products", {
        json: { key: projectKey(), name: "neighbour" },
        key: otherBot.key,
      }),
    ),
  };
});

test("POST /projects creates a project in the caller's own product, led by the caller", async () => {
  const res = await request("POST", "/api/v1/projects", {
    json: { name: "Rest Launch", goal: "go" },
  });
  expect(res.status).toBe(201);
  expect(await json(res)).toMatchObject({
    slug: "rest-launch",
    lead: { id: bot.actor.id, name: "tester", kind: "bot" },
    products: [{ key: mine.key, name: "mine" }],
    hiddenProducts: false,
  });
});

test("POST /projects/{slug}/items adds items from two products and DELETE takes one out", async () => {
  await request("POST", "/api/v1/projects", {
    json: { name: "rest items", slug: "rest-items" },
  });
  const own = await json(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: mine.key, title: "own" },
    }),
  );
  const theirs = await json(
    await request("POST", "/api/v1/items", {
      json: { type: "todo", product: other.product.key, title: "theirs" },
      key: other.key,
    }),
  );
  const added = await request("POST", "/api/v1/projects/rest-items/items", {
    json: { items: [own.key, theirs.key] },
  });
  expect(added.status).toBe(200);
  expect(await json(added)).toMatchObject({
    added: [own.key, theirs.key],
    unchanged: [],
    project: { counts: { open: 2 } },
  });
  const listed = await json(
    await request("GET", "/api/v1/items?project=rest-items"),
  );
  expect(listed.items.map((i: Body) => i.key)).toEqual([theirs.key, own.key]);

  const removed = await request(
    "DELETE",
    `/api/v1/projects/rest-items/items/${own.key}`,
  );
  expect(removed.status).toBe(200);
  expect(await json(removed)).toMatchObject({ removed: [own.key] });
  const again = await json(
    await request("DELETE", `/api/v1/projects/rest-items/items/${own.key}`),
  );
  expect(again).toMatchObject({ removed: [], unchanged: [own.key] });
});

test("POST /projects/{slug}/items refuses more than 100 items and an empty list", async () => {
  for (const items of [[], Array.from({ length: 101 }, (_, i) => `X-${i}`)]) {
    const res = await request("POST", "/api/v1/projects/rest-items/items", {
      json: { items },
    });
    expect(res.status).toBe(422);
  }
});

test("PATCH /projects/{slug} changes the project and refuses a description", async () => {
  const res = await request("PATCH", "/api/v1/projects/rest-launch", {
    json: { targetDate: "2026-12-24", lead: "rest project neighbour" },
  });
  expect(await json(res)).toMatchObject({
    targetDate: "2026-12-24",
    lead: { name: "rest project neighbour" },
  });
  const refused = await request("PATCH", "/api/v1/projects/rest-launch", {
    json: { description: "nope" },
  });
  expect(refused.status).toBe(422);
});

test("a key that reaches no product of a project gets the 404 an unknown slug gets, on every project route", async () => {
  const outsider = createBot(db, "rest project outsider", {
    scope: { projects: [other.product.key] },
  });
  const routes: [string, string, unknown][] = [
    ["GET", "/api/v1/projects/rest-launch", undefined],
    ["PATCH", "/api/v1/projects/rest-launch", { name: "x" }],
    ["POST", "/api/v1/projects/rest-launch/items", { items: ["X-1"] }],
    ["GET", "/api/v1/projects/rest-launch/status-updates", undefined],
    [
      "POST",
      "/api/v1/projects/rest-launch/status-updates",
      { body: "x", health: "on_track" },
    ],
    ["GET", "/api/v1/items?project=rest-launch", undefined],
  ];
  for (const [method, path, body] of routes) {
    const hidden = await request(method, path, {
      json: body,
      key: outsider.key,
    });
    const unknown = await request(
      method,
      path.replace("rest-launch", "no-such-slug"),
      { json: body, key: outsider.key },
    );
    expect(hidden.status, `${method} ${path}`).toBe(404);
    expect((await json(hidden)).error.message).toBe(
      (await json(unknown)).error.message.replace(
        "no-such-slug",
        "rest-launch",
      ),
    );
  }
});
