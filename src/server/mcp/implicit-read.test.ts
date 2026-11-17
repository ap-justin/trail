import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
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
    "not_found: this key reads product ATL only through project recon, which shows ATL's name and key and not its labels: ATL's labels need a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.",
  );
  expect(hidden).not.toContain("list_products");
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
