import { beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

/** An unscoped write that must succeed, as the test app's own bot, which owns what it creates. */
async function seed(method: string, path: string, json: unknown) {
  const res = await request(method, path, { json });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return (await res.json()) as Body;
}

async function call(method: string, path: string, key: string, json?: Body) {
  const res = await request(method, `/api/v1${path}`, { json, key });
  return { status: res.status, body: (await res.json()) as Body };
}

let btaKey = "";
let atlIn = "";
let atlOut = "";
let btaOut = "";

const todo = async (product: string, title: string) =>
  (await seed("POST", "/api/v1/items", { type: "todo", product, title }))
    .key as string;

// products ATL and BTA; project recon draws from both, and each keeps items outside it
beforeAll(async () => {
  for (const key of ["ATL", "BTA"]) {
    await seed("POST", "/api/v1/products", { key, name: `Product ${key}` });
  }
  atlIn = await todo("ATL", "atl in");
  atlOut = await todo("ATL", "atl out");
  btaOut = await todo("BTA", "bta out");
  await seed("POST", "/api/v1/projects", {
    name: "Recon",
    slug: "recon",
    products: ["ATL", "BTA"],
  });
  await seed("POST", "/api/v1/projects/recon/items", { items: [atlIn] });
  btaKey = createBot(db, "beta", { scope: { products: ["BTA"] } }).key;
});

test("GET /items/{key} carries access: product for BTA's items, via_project for recon's ATL items", async () => {
  const bta = await call("GET", `/items/${btaOut}`, btaKey);
  expect(bta.body.access).toBe("product");
  const atl = await call("GET", `/items/${atlIn}`, btaKey);
  expect(atl.status).toBe(200);
  expect(atl.body.access).toBe("via_project");
  expect((await call("GET", `/items/${atlOut}`, btaKey)).status).toBe(404);
});

test("a BTA-only key comments on recon's ATL item, and changing it is a 403 forbidden_scope naming recon, the grants and the owner", async () => {
  const commented = await call("POST", `/items/${atlIn}/comments`, btaKey, {
    body: "seen",
  });
  expect(commented.status).toBe(201);
  const refused = await call("PATCH", `/items/${atlIn}`, btaKey, {
    status: "in_progress",
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toEqual({
    code: "forbidden_scope",
    message: `${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to update an item it needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  });
  const removed = await call(
    "DELETE",
    `/projects/recon/items/${atlIn}`,
    btaKey,
  );
  expect(removed.status).toBe(403);
  expect(removed.body.error.code).toBe("forbidden_scope");
});

test("GET /whoami lists impliedProjects beside a scope of explicit grants", async () => {
  const me = await call("GET", "/whoami", btaKey);
  expect(me.body.impliedProjects).toEqual(["recon"]);
  expect(me.body.scope.projects).toEqual([]);
});

test("a BTA-only key can't add recon's ATL item to a project, nor file on ATL, with or without project recon: 403 forbidden_scope that writes nothing", async () => {
  await seed("POST", "/api/v1/projects", {
    name: "Side",
    slug: "side",
    products: ["BTA"],
  });
  const added = await call("POST", "/projects/side/items", btaKey, {
    items: [atlIn],
  });
  expect(added.status).toBe(403);
  expect(added.body.error).toEqual({
    code: "forbidden_scope",
    message: `${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to add it to a project it needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  });
  const stored = await request("GET", `/api/v1/items/${atlIn}`);
  expect(
    ((await stored.json()) as Body).projects.map((p: Body) => p.slug),
  ).toEqual(["recon"]);
  const before = (await call("GET", "/items?limit=200", btaKey)).body.items
    .length;
  for (const json of [
    { type: "issue", product: "ATL", title: "no" },
    { type: "issue", product: "ATL", project: "recon", title: "no" },
  ]) {
    const filed = await call("POST", "/items", btaKey, json);
    expect(filed.status, JSON.stringify(json)).toBe(403);
    expect(filed.body.error.code).toBe("forbidden_scope");
    expect(filed.body.error.message).toMatch(
      /^this key reads product ATL only through project recon, .* file nothing on ATL: file on BTA/,
    );
  }
  expect(
    (await call("GET", "/items?limit=200", btaKey)).body.items,
  ).toHaveLength(before);
});
