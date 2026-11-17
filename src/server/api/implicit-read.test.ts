import { afterEach, beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setProductOwner } from "../service/product-admin.js";
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
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Body };
}

/** A refusal's body shows neither the item's title nor its description, which opens with the title. */
const hidesItem = (refused: { text: string }, title: string) =>
  expect(refused.text).not.toContain(title);

let btaKey = "";
let atlIn = "";
let atlOut = "";
let btaOut = "";

const todo = async (product: string, title: string) =>
  (
    await seed("POST", "/api/v1/items", {
      type: "todo",
      product,
      title,
      description: `${title}, described`,
    })
  ).key as string;

/** Items a test put into recon, taken out after it so no later test reads recon beyond what it seeds. */
const joinedRecon: string[] = [];
afterEach(async () => {
  setProductOwner(db, "ATL", "tester");
  for (const key of joinedRecon.splice(0)) {
    await seed("DELETE", `/api/v1/projects/recon/items/${key}`, undefined);
  }
});

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
  const hidden = await call("GET", `/items/${atlOut}`, btaKey);
  expect(hidden.status).toBe(404);
  hidesItem(hidden, "atl out");
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
  hidesItem(refused, "atl in");
  expect(refused.body.error).toEqual({
    code: "forbidden_scope",
    message: `${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to update an item, the bot needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  });
  const removed = await call(
    "DELETE",
    `/projects/recon/items/${atlIn}`,
    btaKey,
  );
  expect(removed.status).toBe(403);
  expect(removed.body.error.code).toBe("forbidden_scope");
  hidesItem(removed, "atl in");
});

test("GET /products/ATL/labels is a 404 naming recon, the grants and the owner, not the pointer to list_products; the item keeps its own labels", async () => {
  await seed("POST", "/api/v1/products/ATL/labels", { name: "bug" });
  await seed("PATCH", `/api/v1/items/${atlIn}`, { addLabels: ["bug"] });
  const hidden = await call("GET", "/products/ATL/labels", btaKey);
  const missing = await call("GET", "/products/NOPE/labels", btaKey);
  expect(hidden.status).toBe(404);
  expect(hidden.body.error).toEqual({
    code: missing.body.error.code,
    message:
      "this key reads product ATL only through project recon, which shows ATL's name and key and not its labels: ATL's labels need a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.",
  });
  expect(hidden.text).not.toContain("list_products");
  const aliased = await call("GET", "/projects/ATL/labels", btaKey);
  expect(aliased.status).toBe(404);
  expect(aliased.body.error).toEqual(hidden.body.error);
  const listing = createBot(db, "label-lister", {
    scope: { projects: ["recon"] },
  }).key;
  for (const path of ["/products/ATL/labels", "/projects/ATL/labels"]) {
    const listed = await call("GET", path, listing);
    expect(listed.status, path).toBe(200);
    expect(
      listed.body.items.map((l: Body) => l.name),
      path,
    ).toEqual(["bug"]);
  }
  expect((await call("GET", `/items/${atlIn}`, btaKey)).body.labels).toEqual([
    "bug",
  ]);
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
  hidesItem(added, "atl in");
  expect(added.body.error).toEqual({
    code: "forbidden_scope",
    message: `${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to add it to a project, the bot needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
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

test("add_to_project of an item whose product the project doesn't draw from is a 403 naming the product's grant and owner, and the project keeps its products", async () => {
  await seed("POST", "/api/v1/products", { key: "CTX", name: "Product CTX" });
  await seed("POST", "/api/v1/projects", {
    name: "Context",
    slug: "context",
    products: ["CTX"],
  });
  const drawn = await todo("ATL", "atl to draw");
  await seed("POST", "/api/v1/projects/recon/items", { items: [drawn] });
  joinedRecon.push(drawn);
  const lister = createBot(db, "ctx-lister", {
    scope: { projects: ["recon", "context"] },
  }).key;
  const productsOfContext = async () =>
    (
      (
        (await (
          await request("GET", "/api/v1/projects/context")
        ).json()) as Body
      ).products as Body[]
    )
      .map((p) => p.key)
      .sort();

  const refused = await call("POST", "/projects/context/items", lister, {
    items: [drawn],
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toEqual({
    code: "forbidden_scope",
    message: `adding ${drawn} to project context would draw context from product ATL: to add it, the bot needs a key that lists product ATL. Ask tester, the owner of ATL, for that grant.`,
  });
  hidesItem(refused, "atl to draw");
  expect(await productsOfContext()).toEqual(["CTX"]);

  const granted = createBot(db, "ctx-granted", {
    scope: { products: ["ATL"], projects: ["context"] },
  }).key;
  const added = await call("POST", "/projects/context/items", granted, {
    items: [drawn],
  });
  expect(added.status).toBeLessThan(300);
  expect(added.body.added).toEqual([drawn]);
  expect(await productsOfContext()).toEqual(["ATL", "CTX"]);
});

test("DELETE /projects/{slug}/items/{key} of a member is a 403 for a key reading the project only through its products, and a non-member is a 200 unchanged", async () => {
  await seed("POST", "/api/v1/projects", {
    name: "ATL list",
    slug: "atl-list",
    products: ["ATL"],
  });
  const both = await todo("ATL", "atl in recon and atl-list");
  const outside = await todo("ATL", "atl in atl-list only");
  await seed("POST", "/api/v1/projects/recon/items", { items: [both] });
  joinedRecon.push(both);
  await seed("POST", "/api/v1/projects/atl-list/items", {
    items: [both, outside],
  });
  const mixed = createBot(db, "mixed", {
    scope: { products: ["BTA"], projects: ["atl-list"] },
  }).key;

  const refused = await call("DELETE", `/projects/recon/items/${both}`, mixed);
  expect(refused.status).toBe(403);
  hidesItem(refused, "atl in recon and atl-list");
  expect(refused.body.error).toEqual({
    code: "forbidden_scope",
    message: `${both} is in project recon, which this key reads only through its products: to remove it from recon, the bot needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  });

  const unchanged = await call(
    "DELETE",
    `/projects/recon/items/${outside}`,
    mixed,
  );
  expect(unchanged.status).toBe(200);
  expect(unchanged.body).toMatchObject({ removed: [], unchanged: [outside] });
  const removed = await call(
    "DELETE",
    `/projects/atl-list/items/${both}`,
    mixed,
  );
  expect(removed.body.removed).toEqual([both]);
});

/** A project drawing from BTA only, and a key listing it and recon: ATL's recon items need an ATL grant to join it. */
async function batchTarget(slug: string, keyName: string) {
  await seed("POST", "/api/v1/projects", {
    name: slug,
    slug,
    products: ["BTA"],
  });
  return createBot(db, keyName, { scope: { projects: ["recon", slug] } }).key;
}
const slugsOf = async (ref: string) =>
  (
    ((await (await request("GET", `/api/v1/items/${ref}`)).json()) as Body)
      .projects as Body[]
  )
    .map((p) => p.slug)
    .sort();

test("POST /projects/{slug}/items of [permitted, refused] is a 403 and the permitted item is not added", async () => {
  const lister = await batchTarget("batch", "batch-lister");
  const permitted = await todo("BTA", "bta batch");
  await seed("POST", "/api/v1/projects/recon/items", { items: [permitted] });
  joinedRecon.push(permitted);

  const refused = await call("POST", "/projects/batch/items", lister, {
    items: [permitted, atlIn],
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("forbidden_scope");
  expect(refused.body.error.message).toContain(
    `adding ${atlIn} to project batch would draw batch from product ATL`,
  );
  expect(await slugsOf(permitted)).toEqual(["recon"]);

  // the permitted item alone goes through, so the refusal above is the other one's
  const alone = await call("POST", "/projects/batch/items", lister, {
    items: [permitted],
  });
  expect(alone.body.added).toEqual([permitted]);
  expect(await slugsOf(permitted)).toEqual(["batch", "recon"]);
});

test("POST /projects/{slug}/items drawing a project from a product goes through for a key whose bot owns that product", async () => {
  const lister = await batchTarget("owned", "owned-lister");
  const item = await todo("ATL", "atl owned");
  await seed("POST", "/api/v1/projects/recon/items", { items: [item] });
  joinedRecon.push(item);
  const owner = createBot(db, "atl-owner", {
    scope: { projects: ["recon", "owned"] },
  }).key;

  const refused = await call("POST", "/projects/owned/items", lister, {
    items: [item],
  });
  expect(refused.status).toBe(403);

  setProductOwner(db, "ATL", "atl-owner");
  const added = await call("POST", "/projects/owned/items", owner, {
    items: [item],
  });
  expect(added.status).toBeLessThan(300);
  expect(added.body.added).toEqual([item]);
  expect(await slugsOf(item)).toEqual(["owned", "recon"]);
});

test("POST /projects/{slug}/items drawing a project from a product with no owner is a 403 saying to ask whoever minted the key", async () => {
  const lister = await batchTarget("nobody", "nobody-lister");
  const item = await todo("ATL", "atl nobody");
  await seed("POST", "/api/v1/projects/recon/items", { items: [item] });
  joinedRecon.push(item);
  db.$client
    .prepare("update product set owner_id = null where key = 'ATL'")
    .run();

  const refused = await call("POST", "/projects/nobody/items", lister, {
    items: [item],
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toEqual({
    code: "forbidden_scope",
    message: `adding ${item} to project nobody would draw nobody from product ATL: to add it, the bot needs a key that lists product ATL. Ask whoever minted the key for that grant.`,
  });
  expect(await slugsOf(item)).toEqual(["recon"]);
});
