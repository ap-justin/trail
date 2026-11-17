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

// products ATL and BTA; project recon draws from both, and each keeps items outside it
beforeAll(async () => {
  const wide = await connect(bot.key);
  for (const key of ["ATL", "BTA"]) {
    await call(wide, "create_product", { key, name: `Product ${key}` });
  }
  const todo = async (product: string, title: string) =>
    (await call(wide, "add_todo", { product, title })).key as string;
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
  expect(await callError(beta, "get_item", { item: atlOut })).toContain(
    `no item ${atlOut}`,
  );
});

test("add_comment on recon's ATL item goes through, and update_item is refused naming recon, the grants and the owner", async () => {
  await call(beta, "add_comment", { item: atlIn, body: "seen" });
  expect(
    await callError(beta, "update_item", { item: atlIn, status: "done" }),
  ).toBe(
    `forbidden_scope: ${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to update an item it needs a key that lists product ATL or project recon. Ask tester, the owner of ATL, for that grant.`,
  );
  expect(
    await callError(beta, "remove_from_project", {
      project: "recon",
      items: [atlIn],
    }),
  ).toMatch(/^forbidden_scope: .* only through project recon/);
});

test("whoami lists impliedProjects", async () => {
  const me = await call(beta, "whoami");
  expect(me.impliedProjects).toEqual(["recon"]);
  expect(me.scope.projects).toEqual([]);
});
