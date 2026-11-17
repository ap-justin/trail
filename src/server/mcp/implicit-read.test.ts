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

test("list_labels on ATL is the not_found of a product the key does not reach; get_item keeps the item's labels", async () => {
  const wide = await connect(bot.key);
  await call(wide, "create_label", { product: "ATL", name: "bug" });
  await call(wide, "update_item", { item: atlIn, addLabels: ["bug"] });
  const missing = await callError(beta, "list_labels", { product: "NOPE" });
  expect(await callError(beta, "list_labels", { product: "ATL" })).toBe(
    missing?.replace("NOPE", "ATL"),
  );
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
