import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeAll, describe, expect, test } from "vitest";
import {
  createBot,
  editKeyScope,
  type KeyScopeInput,
} from "../service/keys.js";
import { setProductOwner } from "../service/product-admin.js";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, db, bot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

let wide: Client;

/** A scoped bot's connected client and the prefix `editKeyScope` finds its key by. */
async function keyed(name: string, scope: KeyScopeInput) {
  const { key } = createBot(db, name, { scope });
  return { client: await connect(key), prefix: key.slice(6, 14) };
}

/** A bot that owns product `code`, created through the tool. */
async function ownerOf(code: string) {
  const client = await connect(createBot(db, `owner-${code}`).key);
  await call(client, "create_product", { key: code, name: code });
  return client;
}

beforeAll(async () => {
  wide = await connect(bot.key);
  for (const key of ["ATL", "BTA"]) {
    await call(wide, "create_product", { key, name: `Product ${key}` });
  }
  await call(wide, "create_project", {
    name: "Recon",
    slug: "recon",
    products: ["ATL", "BTA"],
  });
  await call(wide, "create_project", {
    name: "Solo",
    slug: "solo",
    products: ["BTA"],
  });
});

describe("a replayed create over MCP", () => {
  test("add_todo, once the caller no longer owns the product, is the error a new todo gets, and writes nothing", async () => {
    const owner = await ownerOf("OWN");
    const args = (idempotency_key: string) => ({
      product: "OWN",
      title: "mine for now",
      idempotency_key,
    });
    const first = await call(owner, "add_todo", args("todo-once"));
    expect((await call(owner, "add_todo", args("todo-once"))).id).toBe(
      first.id,
    );
    setProductOwner(db, "OWN", "tester");

    const replay = await callError(owner, "add_todo", args("todo-once"));
    expect(replay).toMatch(/^forbidden/);
    expect(replay).toBe(await callError(owner, "add_todo", args("todo-fresh")));
  });

  test("add_comment on an item that has left the key's one project is the error a new comment gets, without the title", async () => {
    const { client } = await keyed("commenter", { projects: ["recon"] });
    const item = await call(client, "file_issue", {
      product: "ATL",
      project: "recon",
      title: "to comment on",
    });
    const args = (idempotency_key: string) => ({
      item: item.key,
      body: "noted",
      idempotency_key,
    });
    const first = await call(client, "add_comment", args("comment-once"));
    expect((await call(client, "add_comment", args("comment-once"))).id).toBe(
      first.id,
    );
    await call(wide, "remove_from_project", {
      project: "recon",
      items: [item.key],
    });

    const replay = await callError(client, "add_comment", args("comment-once"));
    expect(replay).toMatch(/^not_found/);
    expect(replay).toBe(
      await callError(client, "add_comment", args("comment-fresh")),
    );
    expect(replay).not.toContain("to comment on");
  });

  test("post_status_update on a project the key lost is the error a new post gets", async () => {
    const { client, prefix } = await keyed("project-poster", {
      projects: ["recon", "solo"],
    });
    const args = (idempotency_key: string) => ({
      project: "recon",
      body: "on track",
      health: "on_track",
      idempotency_key,
    });
    const first = await call(
      client,
      "post_status_update",
      args("project-post"),
    );
    expect(
      (await call(client, "post_status_update", args("project-post"))).id,
    ).toBe(first.id);
    editKeyScope(db, prefix, { removeProjects: ["recon"] });

    const replay = await callError(
      client,
      "post_status_update",
      args("project-post"),
    );
    expect(replay).toMatch(/^not_found/);
    expect(replay).toBe(
      await callError(client, "post_status_update", args("project-fresh")),
    );
  });

  test("create_project by a key that lost the product it defaulted to is the error a read of the project is", async () => {
    const { client, prefix } = await keyed("project-maker", {
      products: ["ATL", "BTA"],
    });
    setProductOwner(db, "ATL", "project-maker");
    const args = {
      name: "Defaulted",
      slug: "defaulted",
      idempotency_key: "project-once",
    };
    const first = await call(client, "create_project", args);
    expect((await call(client, "create_project", args)).id).toBe(first.id);
    editKeyScope(db, prefix, { removeProducts: ["ATL"] });

    const replay = await callError(client, "create_project", args);
    expect(replay).toMatch(/^not_found/);
    expect(replay).toBe(
      await callError(client, "get_project", { project: "defaulted" }),
    );
  });

  test("create_label, once the caller no longer owns the product, is the error a new label gets", async () => {
    const owner = await ownerOf("LBL");
    const args = (idempotency_key: string) => ({
      product: "LBL",
      name: "bug",
      idempotency_key,
    });
    const first = await call(owner, "create_label", args("label-once"));
    expect(await call(owner, "create_label", args("label-once"))).toEqual(
      first,
    );
    setProductOwner(db, "LBL", "tester");

    const replay = await callError(owner, "create_label", args("label-once"));
    expect(replay).toMatch(/^forbidden/);
    expect(replay).toBe(
      await callError(owner, "create_label", args("label-fresh")),
    );
  });
});
