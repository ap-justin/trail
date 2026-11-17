import { beforeAll, describe, expect, test } from "vitest";
import {
  createBot,
  editKeyScope,
  type KeyScopeInput,
} from "../service/keys.js";
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

/** A create as `key`, safe to retry under `idempotency`. */
const create = (
  method: string,
  path: string,
  key: string,
  idempotency: string,
  json?: Body,
) =>
  request(method, `/api/v1${path}`, {
    key,
    json,
    headers: { "idempotency-key": idempotency },
  });

const read = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Body,
});

/** A scoped bot's key and the prefix `editKeyScope` finds it by. */
function keyed(name: string, scope: KeyScopeInput) {
  const { key } = createBot(db, name, { scope });
  return { key, prefix: key.slice(6, 14) };
}

beforeAll(async () => {
  for (const key of ["ATL", "BTA"]) {
    await seed("POST", "/api/v1/products", { key, name: `Product ${key}` });
  }
  await seed("POST", "/api/v1/projects", {
    name: "Recon",
    slug: "recon",
    products: ["ATL", "BTA"],
  });
  await seed("POST", "/api/v1/projects", {
    name: "Solo",
    slug: "solo",
    products: ["BTA"],
  });
});

/** A bot that owns product `code`, made over REST, and the key that made it. */
async function ownerOf(code: string) {
  const { key } = createBot(db, `owner-${code}`);
  const made = await request("POST", "/api/v1/products", {
    key,
    json: { key: code, name: code },
  });
  expect(made.status).toBe(201);
  return key;
}

describe("a replayed create over REST", () => {
  test("add_todo, once the caller no longer owns the product, is the 403 a new todo gets, and writes nothing", async () => {
    const owner = await ownerOf("OWN");
    const todo = { type: "todo", product: "OWN", title: "mine for now" };
    const first = await read(
      await create("POST", "/items", owner, "todo-once", todo),
    );
    expect(first.status).toBe(201);
    const again = await read(
      await create("POST", "/items", owner, "todo-once", todo),
    );
    expect(again.body.id).toBe(first.body.id);
    setProductOwner(db, "OWN", "tester");

    const replay = await read(
      await create("POST", "/items", owner, "todo-once", todo),
    );
    expect(replay.status).toBe(403);
    expect(replay).toEqual(
      await read(await create("POST", "/items", owner, "todo-fresh", todo)),
    );
  });

  test("a comment on an item that has left the key's one project is the 404 a new comment gets, without the title", async () => {
    const { key } = keyed("commenter", { projects: ["recon"] });
    const item = await read(
      await create("POST", "/items", key, "item-for-comment", {
        type: "issue",
        product: "ATL",
        project: "recon",
        title: "to comment on",
      }),
    );
    const comment = (idempotency: string) =>
      create("POST", `/items/${item.body.key}/comments`, key, idempotency, {
        body: "noted",
      });
    const first = await read(await comment("comment-once"));
    expect(first.status).toBe(201);
    expect((await read(await comment("comment-once"))).body.id).toBe(
      first.body.id,
    );
    await request("DELETE", `/api/v1/projects/recon/items/${item.body.key}`);

    const replay = await read(await comment("comment-once"));
    expect(replay.status).toBe(404);
    expect(replay).toEqual(await read(await comment("comment-fresh")));
    expect(JSON.stringify(replay.body)).not.toContain("to comment on");
  });

  test("a project status update by a key that lost the project is the 404 a new post gets", async () => {
    const bot = keyed("project-poster", { projects: ["recon", "solo"] });
    const post = (idempotency: string) =>
      create("POST", "/projects/recon/status-updates", bot.key, idempotency, {
        body: "on track",
        health: "on_track",
      });
    const first = await read(await post("project-post"));
    expect(first.status).toBe(201);
    expect((await read(await post("project-post"))).body.id).toBe(
      first.body.id,
    );
    editKeyScope(db, bot.prefix, { removeProjects: ["recon"] });

    const replay = await read(await post("project-post"));
    expect(replay.status).toBe(404);
    expect(replay).toEqual(await read(await post("project-fresh")));
  });

  test("create_project by a key that lost the product it defaulted to is the 404 a read of the project is", async () => {
    const bot = keyed("project-maker", { products: ["ATL", "BTA"] });
    setProductOwner(db, "ATL", "project-maker");
    const make = () =>
      create("POST", "/projects", bot.key, "project-once", {
        name: "Defaulted",
        slug: "defaulted",
      });
    const first = await read(await make());
    expect(first.status).toBe(201);
    expect((await read(await make())).body.id).toBe(first.body.id);
    editKeyScope(db, bot.prefix, { removeProducts: ["ATL"] });

    const replay = await read(await make());
    expect(replay.status).toBe(404);
    expect(replay).toEqual(
      await read(
        await request("GET", "/api/v1/projects/defaulted", { key: bot.key }),
      ),
    );
  });

  test("create_label, once the caller no longer owns the product, is the 403 a new label gets", async () => {
    const owner = await ownerOf("LBL");
    const label = (idempotency: string) =>
      create("POST", "/products/LBL/labels", owner, idempotency, {
        name: "bug",
      });
    const first = await read(await label("label-once"));
    expect(first.status).toBe(201);
    expect(await read(await label("label-once"))).toEqual(first);
    setProductOwner(db, "LBL", "tester");

    const replay = await read(await label("label-once"));
    expect(replay.status).toBe(403);
    expect(replay).toEqual(await read(await label("label-fresh")));
  });
});
