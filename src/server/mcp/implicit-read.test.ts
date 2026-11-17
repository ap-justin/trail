import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setProductOwner } from "../service/product-admin.js";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, db, bot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

let beta: Client;
let atlIn = "";
let atlOut = "";
let btaOut = "";

/** A refusal shows neither the item's title nor its description, which opens with the title. */
const hidesItem = (refusal: string | undefined, title: string) =>
  expect(refusal).not.toContain(title);

/** Items a test put into recon, taken out after it so no later test reads recon beyond what it seeds. */
const joinedRecon: string[] = [];
afterEach(async () => {
  setProductOwner(db, "ATL", "tester");
  if (joinedRecon.length === 0) return;
  const wide = await connect(bot.key);
  await call(wide, "remove_from_project", {
    project: "recon",
    items: joinedRecon.splice(0),
  });
});

// products ATL and BTA; project recon draws from both, and each keeps items outside it
beforeAll(async () => {
  const wide = await connect(bot.key);
  for (const key of ["ATL", "BTA"]) {
    await call(wide, "create_product", { key, name: `Product ${key}` });
  }
  const todo = async (product: string, title: string) =>
    (
      await call(wide, "add_todo", {
        product,
        title,
        description: `${title}, described`,
      })
    ).key as string;
  atlIn = await todo("ATL", "atl in");
  atlOut = await todo("ATL", "atl out");
  btaOut = await todo("BTA", "bta out");
  await call(wide, "create_project", {
    name: "Recon",
    slug: "recon",
    products: ["ATL", "BTA"],
  });
  await call(wide, "add_to_project", { project: "recon", items: [atlIn] });
  beta = await connect(
    createBot(db, "beta", { scope: { products: ["BTA"] } }).key,
  );
});

test("get_item carries access: product for BTA's items, via_project for recon's ATL items", async () => {
  expect((await call(beta, "get_item", { item: btaOut })).access).toBe(
    "product",
  );
  expect((await call(beta, "get_item", { item: atlIn })).access).toBe(
    "via_project",
  );
  const hidden = await callError(beta, "get_item", { item: atlOut });
  expect(hidden).toContain(`no item ${atlOut}`);
  hidesItem(hidden, "atl out");
});

test("add_comment on recon's ATL item goes through, and update_item is refused naming recon, the grants and the owner", async () => {
  await call(beta, "add_comment", { item: atlIn, body: "seen" });
  const refused = await callError(beta, "update_item", {
    item: atlIn,
    status: "done",
  });
  hidesItem(refused, "atl in");
  expect(refused).toBe(
    `forbidden_scope: ${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to update an item, the bot needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  );
  const removed = await callError(beta, "remove_from_project", {
    project: "recon",
    items: [atlIn],
  });
  expect(removed).toMatch(/^forbidden_scope: .* only through project recon/);
  hidesItem(removed, "atl in");
});

test("list_labels on ATL is a not_found naming recon, the grants and the owner, not the pointer to list_products; get_item keeps the item's labels", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_label", { product: "ATL", name: "bug" });
  await call(wide, "update_item", { item: atlIn, addLabels: ["bug"] });
  const hidden = await callError(beta, "list_labels", { product: "ATL" });
  expect(hidden).toBe(
    "not_found: this key reads only the name and key of product ATL, through project recon: ATL's labels need a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.",
  );
  expect(hidden).not.toContain("list_products");
  const listing = await connect(
    createBot(db, "label-lister", { scope: { projects: ["recon"] } }).key,
  );
  expect(
    (await call(listing, "list_labels", { product: "ATL" })).items.map(
      (l: { name: string }) => l.name,
    ),
  ).toEqual(["bug"]);
  expect((await call(beta, "get_item", { item: atlIn })).labels).toEqual([
    "bug",
  ]);
});

test("whoami lists impliedProjects", async () => {
  const me = await call(beta, "whoami");
  expect(me.impliedProjects).toEqual(["recon"]);
  expect(me.scope.projects).toEqual([]);
});

test("add_to_project of recon's ATL item and file_issue on ATL are refused with forbidden_scope, and write nothing", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_project", {
    name: "Side",
    slug: "side",
    products: ["BTA"],
  });
  const added = await callError(beta, "add_to_project", {
    project: "side",
    items: [atlIn],
  });
  hidesItem(added, "atl in");
  expect(added).toMatch(
    /^forbidden_scope: .* only through project recon, .* to add it to a project, the bot needs a key that lists product ATL or project recon\./,
  );
  const before = (await call(beta, "list_items", { limit: 200 })).items.length;
  for (const args of [
    { product: "ATL", title: "no" },
    { product: "ATL", project: "recon", title: "no" },
  ]) {
    expect(await callError(beta, "file_issue", args)).toMatch(
      /^forbidden_scope: this key reads product ATL only through project recon, .* file nothing on ATL: file on BTA/,
    );
  }
  expect((await call(beta, "list_items", { limit: 200 })).items).toHaveLength(
    before,
  );
});

test("add_to_project of an item whose product the project doesn't draw from is refused naming the product's grant and owner, and the project keeps its products", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_product", { key: "CTX", name: "Product CTX" });
  await call(wide, "create_project", {
    name: "Context",
    slug: "context",
    products: ["CTX"],
  });
  const drawn = (
    await call(wide, "add_todo", { product: "ATL", title: "atl to draw" })
  ).key as string;
  await call(wide, "add_to_project", { project: "recon", items: [drawn] });
  joinedRecon.push(drawn);
  const lister = await connect(
    createBot(db, "ctx-lister", { scope: { projects: ["recon", "context"] } })
      .key,
  );
  const productsOfContext = async () =>
    (await call(wide, "get_project", { project: "context" })).products
      .map((p: { key: string }) => p.key)
      .sort();

  const refused = await callError(lister, "add_to_project", {
    project: "context",
    items: [drawn],
  });
  expect(refused).toBe(
    `forbidden_scope: adding ${drawn} to project context would draw context from product ATL: to add it, the bot needs a key that lists product ATL. Ask tester, the owner of ATL, for that grant.`,
  );
  hidesItem(refused, "atl to draw");
  expect(await productsOfContext()).toEqual(["CTX"]);

  const granted = await connect(
    createBot(db, "ctx-granted", {
      scope: { products: ["ATL"], projects: ["context"] },
    }).key,
  );
  const added = await call(granted, "add_to_project", {
    project: "context",
    items: [drawn],
  });
  expect(added.added).toEqual([drawn]);
  expect(await productsOfContext()).toEqual(["ATL", "CTX"]);
});

test("remove_from_project of a member is refused for a key reading the project only through its products, and a non-member is listed unchanged", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_project", {
    name: "ATL list",
    slug: "atl-list",
    products: ["ATL"],
  });
  const todo = async (title: string) =>
    (await call(wide, "add_todo", { product: "ATL", title })).key as string;
  const both = await todo("atl in recon and atl-list");
  const outside = await todo("atl in atl-list only");
  await call(wide, "add_to_project", { project: "recon", items: [both] });
  joinedRecon.push(both);
  await call(wide, "add_to_project", {
    project: "atl-list",
    items: [both, outside],
  });
  const mixed = await connect(
    createBot(db, "mixed", {
      scope: { products: ["BTA"], projects: ["atl-list"] },
    }).key,
  );

  const refused = await callError(mixed, "remove_from_project", {
    project: "recon",
    items: [both],
  });
  hidesItem(refused, "atl in recon and atl-list");
  expect(refused).toBe(
    `forbidden_scope: ${both} is in project recon, which this key reads only through its products: to remove it from recon, the bot needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  );

  const unchanged = await call(mixed, "remove_from_project", {
    project: "recon",
    items: [outside],
  });
  expect(unchanged).toMatchObject({ removed: [], unchanged: [outside] });
  expect(
    (
      await call(mixed, "remove_from_project", {
        project: "atl-list",
        items: [both],
      })
    ).removed,
  ).toEqual([both]);
});

/** A project drawing from `product` only, and a key listing it and recon. */
async function target(slug: string, product: string, keyName: string) {
  const wide = await connect(bot.key);
  await call(wide, "create_project", { name: slug, slug, products: [product] });
  return connect(
    createBot(db, keyName, { scope: { projects: ["recon", slug] } }).key,
  );
}
const slugsOf = async (ref: string) =>
  (await call(await connect(bot.key), "get_item", { item: ref })).projects
    .map((p: { slug: string }) => p.slug)
    .sort();

test("add_to_project of [permitted, refused] is refused and the permitted item is not added", async () => {
  const wide = await connect(bot.key);
  const lister = await target("batch", "BTA", "batch-lister");
  const permitted = (
    await call(wide, "add_todo", { product: "BTA", title: "bta batch" })
  ).key as string;
  await call(wide, "add_to_project", { project: "recon", items: [permitted] });
  joinedRecon.push(permitted);

  const refused = await callError(lister, "add_to_project", {
    project: "batch",
    items: [permitted, atlIn],
  });
  expect(refused).toMatch(
    new RegExp(
      `^forbidden_scope: adding ${atlIn} to project batch would draw batch from product ATL`,
    ),
  );
  expect(await slugsOf(permitted)).toEqual(["recon"]);

  // the permitted item alone goes through, so the refusal above is the other one's
  const alone = await call(lister, "add_to_project", {
    project: "batch",
    items: [permitted],
  });
  expect(alone.added).toEqual([permitted]);
  expect(await slugsOf(permitted)).toEqual(["batch", "recon"]);
});

test("remove_from_project of [permitted, refused] is refused and the permitted item stays", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_project", {
    name: "ATL batch",
    slug: "atl-batch",
    products: ["ATL"],
  });
  const member = (
    await call(wide, "add_todo", { product: "BTA", title: "bta member" })
  ).key as string;
  const both = (
    await call(wide, "add_todo", { product: "ATL", title: "atl batch" })
  ).key as string;
  await call(wide, "add_to_project", {
    project: "recon",
    items: [member, both],
  });
  joinedRecon.push(member, both);
  await call(wide, "add_to_project", { project: "atl-batch", items: [both] });
  const mixed = await connect(
    createBot(db, "batch-mixed", {
      scope: { products: ["BTA"], projects: ["atl-batch"] },
    }).key,
  );

  const refused = await callError(mixed, "remove_from_project", {
    project: "recon",
    items: [member, both],
  });
  expect(refused).toMatch(
    new RegExp(`^forbidden_scope: ${both} is in project recon, `),
  );
  expect(await slugsOf(member)).toEqual(["recon"]);
  expect(await slugsOf(both)).toEqual(["atl-batch", "recon"]);

  // the permitted item alone goes through, so the refusal above is the other one's
  const alone = await call(mixed, "remove_from_project", {
    project: "recon",
    items: [member],
  });
  expect(alone.removed).toEqual([member]);
});

test("add_to_project drawing a project from a product goes through for a key whose bot owns that product", async () => {
  const wide = await connect(bot.key);
  const lister = await target("owned", "BTA", "owned-lister");
  const item = (await call(wide, "add_todo", { product: "ATL", title: "owned" }))
    .key as string;
  await call(wide, "add_to_project", { project: "recon", items: [item] });
  joinedRecon.push(item);
  const owner = await connect(
    createBot(db, "atl-owner", { scope: { projects: ["recon", "owned"] } }).key,
  );

  expect(
    await callError(lister, "add_to_project", {
      project: "owned",
      items: [item],
    }),
  ).toMatch(/^forbidden_scope: adding /);
  setProductOwner(db, "ATL", "atl-owner");
  const added = await call(owner, "add_to_project", {
    project: "owned",
    items: [item],
  });
  expect(added.added).toEqual([item]);
  expect(await slugsOf(item)).toEqual(["owned", "recon"]);
});

test("add_to_project drawing a project from a product with no owner says to ask whoever minted the key", async () => {
  const wide = await connect(bot.key);
  const lister = await target("nobody", "BTA", "nobody-lister");
  const item = (
    await call(wide, "add_todo", { product: "ATL", title: "nobody" })
  ).key as string;
  await call(wide, "add_to_project", { project: "recon", items: [item] });
  joinedRecon.push(item);
  db.$client
    .prepare("update product set owner_id = null where key = 'ATL'")
    .run();

  expect(
    await callError(lister, "add_to_project", {
      project: "nobody",
      items: [item],
    }),
  ).toBe(
    `forbidden_scope: adding ${item} to project nobody would draw nobody from product ATL: to add it, the bot needs a key that lists product ATL. Ask whoever minted the key for that grant.`,
  );
  expect(await slugsOf(item)).toEqual(["recon"]);
});
