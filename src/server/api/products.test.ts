import { expect, test } from "vitest";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";

const { app, bot, addBot, request } = setupTestApp();

const isoTimestamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);

test("POST /products creates a product as the calling bot and returns 201", async () => {
  const res = await request("POST", "/api/v1/products", {
    json: { key: "TRL", name: "trail", description: "issue tracker" },
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    id: expect.any(String),
    key: "TRL",
    name: "trail",
    kind: "product",
    description: "issue tracker",
    repoUrl: null,
    owner: { id: bot.actor.id, name: "tester", kind: "bot" },
    externalRef: null,
    createdBy: bot.actor.id,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  });
});

async function createProduct(name: string) {
  const res = await request("POST", "/api/v1/products", {
    json: { key: projectKey(), name },
  });
  return (await res.json()) as { id: string; key: string; name: string };
}

test("GET /products/:id returns the project; an unknown id is a 404", async () => {
  const { id } = await createProduct("get-me");
  const res = await request("GET", `/api/v1/products/${id}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id, name: "get-me" });

  const missing = await request("GET", "/api/v1/products/nope");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: {
      code: "not_found",
      message:
        "no product nope: pass the key (like TRL) of a product this key reaches; list_products (GET /api/v1/products) lists them",
    },
  });
});

test("PATCH /products/:id changes only the fields sent", async () => {
  const { id } = await createProduct("before");
  const res = await request("PATCH", `/api/v1/products/${id}`, {
    json: { description: "now described" },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    id,
    name: "before",
    description: "now described",
  });

  const missing = await request("PATCH", "/api/v1/products/nope", {
    json: { name: "x" },
  });
  expect(missing.status).toBe(404);
});

const validationFailed = (message: unknown) => ({
  error: { code: "validation_failed", message },
});

test.each([
  ["a missing required field", {}, /^name: /],
  ["a field of the wrong type", { name: 7 }, /^name: /],
  ["an empty name", { name: "" }, /^name: /],
  ["a field the schema does not know", { name: "x", nmae: "y" }, /nmae/],
])(
  "POST /products with %s is a 422 naming the field",
  async (_, json, message) => {
    const res = await request("POST", "/api/v1/products", { json });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(
      validationFailed(expect.stringMatching(message)),
    );
  },
);

test("a blank name the service rejects is a 422 in the same shape", async () => {
  const res = await request("POST", "/api/v1/products", {
    json: { key: projectKey(), name: "   " },
  });
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual(validationFailed("name must not be empty"));
});

test("a write with no body is a 422", async () => {
  const res = await request("POST", "/api/v1/products");
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual(validationFailed(expect.any(String)));
});

test("a body sent without a JSON Content-Type is a 415, not an empty patch", async () => {
  const { id } = await createProduct("typed");
  const res = await app.request(`/api/v1/products/${id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "text/plain",
    },
    body: JSON.stringify({ name: "renamed" }),
  });
  expect(res.status).toBe(415);
  expect(await res.json()).toEqual({
    error: { code: "unsupported_media_type", message: expect.any(String) },
  });
  const after = await request("GET", `/api/v1/products/${id}`);
  expect(await after.json()).toMatchObject({ name: "typed" });
});

test("malformed JSON is a 400 in the shared shape", async () => {
  const res = await app.request("/api/v1/products", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "application/json",
    },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "bad_request", message: expect.any(String) },
  });
});

test.each([
  [
    "cursor=garbage",
    "cursor is invalid: pass a nextCursor exactly as the previous page returned it, or leave cursor out for the first page",
  ],
  ["limit=0", expect.stringMatching(/^limit: /)],
  ["limit=201", expect.stringMatching(/^limit: /)],
  ["limit=two", expect.stringMatching(/^limit: /)],
])("GET /products?%s is a 422", async (query, message) => {
  const res = await request("GET", `/api/v1/products?${query}`);
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual(validationFailed(message));
});

test("GET /products pages newest first through nextCursor", async () => {
  await atFakeTimeAsync(
    ["page-a", "page-b", "page-c"].map((name) => () => createProduct(name)),
  );
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = cursor ? `&cursor=${cursor}` : "";
    const res = await request("GET", `/api/v1/products?limit=2${query}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: { name: string }[];
      nextCursor: string | null;
    };
    expect(page.items.length).toBeLessThanOrEqual(2);
    seen.push(...page.items.map((p) => p.name));
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null);
  expect(pages).toBe(Math.ceil(seen.length / 2));
  expect(new Set(seen).size).toBe(seen.length);
  // earlier tests' products were written at real time, after these fake-stamped ones
  expect(seen.filter((n) => n.startsWith("page-"))).toEqual([
    "page-c",
    "page-b",
    "page-a",
  ]);
});

test("GET /products accepts the limit bounds 1 and 200", async () => {
  await createProduct("bounds");
  for (const limit of [1, 200]) {
    const res = await request("GET", `/api/v1/products?limit=${limit}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[] };
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.items.length).toBeLessThanOrEqual(limit);
  }
});

test("PATCH /products/:key handing over or clearing the owner by an admin key that isn't the owner is a 403 naming the owner and the operator command", async () => {
  const product = await createProduct("owned elsewhere");
  const outsider = addBot("owner grabber");
  for (const owner of ["owner grabber", null]) {
    const res = await request("PATCH", `/api/v1/products/${product.key}`, {
      json: { owner },
      key: outsider.key,
    });
    expect(res.status, String(owner)).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "forbidden",
        message: `${product.key} is owned by tester: only tester may hand it to another bot or clear its owner over the API. The operator reassigns it with \`trail products set-owner ${product.key} <bot>\``,
      },
    });
  }
  const after = await request("GET", `/api/v1/products/${product.key}`);
  expect(((await after.json()) as { owner: { id: string } }).owner.id).toBe(
    bot.actor.id,
  );
  // its other fields stay open to any admin key
  const renamed = await request("PATCH", `/api/v1/products/${product.key}`, {
    json: { name: "renamed by another admin" },
    key: outsider.key,
  });
  expect(renamed.status).toBe(200);
});

test("the owner hands a product to another bot or clears its owner, and a product with no owner may be claimed", async () => {
  const product = await createProduct("handed over");
  const heir = addBot("product heir");
  const handed = await request("PATCH", `/api/v1/products/${product.key}`, {
    json: { owner: "product heir" },
  });
  expect(handed.status).toBe(200);
  expect(await handed.json()).toMatchObject({
    owner: { id: heir.actor.id, name: "product heir" },
  });
  const cleared = await request("PATCH", `/api/v1/products/${product.key}`, {
    json: { owner: null },
    key: heir.key,
  });
  expect(await cleared.json()).toMatchObject({ owner: null });
  const claimed = await request("PATCH", `/api/v1/products/${product.key}`, {
    json: { owner: "tester" },
  });
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({
    owner: { id: bot.actor.id },
  });
});
