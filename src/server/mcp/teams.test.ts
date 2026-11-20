import { expect, test } from "vitest";
import { createBot, createKey } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

/** A bot that owns nothing, with an MCP client on a key with the issues action alone. */
async function newcomer(name: string) {
  const made = createBot(db, name, {
    scope: { actions: ["read", "issues", "comments"] },
  });
  return { ...made, client: await connect(made.key) };
}

test("create_team: a bot that owns nothing creates its team, owned by itself, with an issues key", async () => {
  const bot = await newcomer("Tamsin");
  const key = projectKey();
  const team = await call(bot.client, "create_team", {
    key,
    name: "Tamsin's desk",
    description: "where Tamsin keeps its own work",
  });
  expect(team).toMatchObject({
    key,
    name: "Tamsin's desk",
    kind: "team",
    description: "where Tamsin keeps its own work",
    owner: { id: bot.actor.id, name: "Tamsin", kind: "bot" },
    createdBy: bot.actor.id,
  });
});

test("create_team: a bot that owns a team already is refused, pointed at its team and at an admin", async () => {
  const bot = await newcomer("Tobin");
  const first = await call(bot.client, "create_team", {
    key: projectKey(),
    name: "Tobin's desk",
  });
  const second = projectKey();
  expect(
    await callError(bot.client, "create_team", { key: second, name: "again" }),
  ).toBe(
    `conflict: you already own team ${first.key}, and a bot owns at most one team: keep your own work there (add_todo, add_note with product ${first.key}); an admin creates more products or teams with create_product (POST /products)`,
  );
  const listed = await call(bot.client, "list_products", { limit: 200 });
  expect(listed.items.map((p: { key: string }) => p.key)).not.toContain(second);
});

test("create_team: a bot that owns a product is refused, pointed at its product, even when its key doesn't reach it", async () => {
  const admin = createBot(db, "Petra");
  const product = await call(await connect(admin.key), "create_product", {
    key: projectKey(),
    name: "Petra's product",
  });
  const elsewhere = await call(await connect(admin.key), "create_product", {
    key: projectKey(),
    name: "somewhere else",
    owner: null,
  });
  const narrow = createKey(db, admin.actor.id, {
    products: [elsewhere.key],
    actions: ["read", "issues"],
  });
  expect(
    await callError(await connect(narrow.key), "create_team", {
      key: projectKey(),
      name: "a team too",
    }),
  ).toBe(
    `conflict: you own product ${product.key}, and a team is only for a bot that owns no product or team: keep your own work in ${product.key} (add_todo, add_note with product ${product.key}); an admin creates more products or teams with create_product (POST /products)`,
  );
});

test("create_team: a key without the issues action is refused before anything is written", async () => {
  const reader = createBot(db, "Ronan", { scope: { actions: ["read"] } });
  const client = await connect(reader.key);
  expect(
    await callError(client, "create_team", {
      key: projectKey(),
      name: "read only",
    }),
  ).toBe(
    "forbidden_action: this key may not create a team: that needs the issues action, and the key has read. Ask whoever minted the key for one with the issues action.",
  );
  expect((await call(client, "whoami")).team).toBeNull();
});

test("create_team with an idempotency_key: a retry returns the first team and writes nothing", async () => {
  const bot = await newcomer("Ilse");
  const args = {
    key: projectKey(),
    name: "Ilse's desk",
    idempotency_key: "ilse-team-1",
  };
  const first = await call(bot.client, "create_team", args);
  const again = await call(bot.client, "create_team", args);
  expect(again).toEqual(first);
  const events = await call(bot.client, "list_activity", {
    product: first.key,
  });
  expect(events.items).toEqual([
    expect.objectContaining({
      action: "product.created",
      payload: expect.objectContaining({ key: first.key, kind: "team" }),
    }),
  ]);
});

test("create_team adds the team to each of the bot's keys limited to products; unlimited and project-only keys stay as they were", async () => {
  const admin = createBot(db, "Ada");
  const adminClient = await connect(admin.key);
  const shared = await call(adminClient, "create_product", {
    key: projectKey(),
    name: "shared",
    owner: null,
  });
  const project = await call(adminClient, "create_project", {
    name: "shared work",
    products: [shared.key],
  });
  const worker = createBot(db, "Wren", {
    scope: { products: [shared.key], actions: ["read", "issues"] },
  });
  const second = createKey(db, worker.actor.id, { products: [shared.key] });
  const unlimited = createKey(db, worker.actor.id);
  const projectOnly = createKey(db, worker.actor.id, {
    projects: [project.slug],
  });
  const scopeOf = async (key: string) =>
    (await call(await connect(key), "whoami")).scope;

  const team = await call(await connect(worker.key), "create_team", {
    key: projectKey(),
    name: "Wren's desk",
  });

  for (const key of [worker.key, second.key]) {
    expect((await scopeOf(key)).products).toEqual(
      [shared.key, team.key].sort(),
    );
  }
  expect((await scopeOf(unlimited.key)).products).toBeNull();
  expect(await scopeOf(projectOnly.key)).toMatchObject({
    products: [],
    projects: [project.slug],
  });
  const todo = await call(await connect(worker.key), "add_todo", {
    product: team.key,
    title: "first thing in the team",
  });
  expect(todo).toMatchObject({ key: `${team.key}-1`, type: "todo" });
});

const ownsNothingHint =
  "You own no product and no team. For your own work, create your team with create_team and add todos there; write records with add_note; to ask a product's bot for work, file an issue on its product with file_issue.";

test("whoami: a bot that owns nothing gets team null and a hint; once it has a team, the team and no hint, on a key that doesn't reach it too", async () => {
  const bot = await newcomer("Hollis");
  const before = await call(bot.client, "whoami");
  expect(before).toMatchObject({ team: null, hint: ownsNothingHint });

  const team = await call(bot.client, "create_team", {
    key: projectKey(),
    name: "Hollis's desk",
  });
  const after = await call(bot.client, "whoami");
  expect(after.team).toEqual({ key: team.key, name: "Hollis's desk" });
  expect(after).not.toHaveProperty("hint");

  const admin = createBot(db, "Hale");
  const project = await call(await connect(admin.key), "create_project", {
    name: "far away",
    products: [
      (
        await call(await connect(admin.key), "create_product", {
          key: projectKey(),
          name: "far",
        })
      ).key,
    ],
  });
  const projectOnly = createKey(db, bot.actor.id, {
    projects: [project.slug],
  });
  const narrow = await call(await connect(projectOnly.key), "whoami");
  expect(narrow.team).toEqual({ key: team.key, name: "Hollis's desk" });
  expect(narrow).not.toHaveProperty("hint");
});

test("whoami: a bot that owns a product gets team null and no hint", async () => {
  const owner = createBot(db, "Odile");
  const client = await connect(owner.key);
  await call(client, "create_product", { key: projectKey(), name: "Odile's" });
  const me = await call(client, "whoami");
  expect(me.team).toBeNull();
  expect(me).not.toHaveProperty("hint");
});

test("create_product takes kind, product by default; update_product changes it; list_products filters on it", async () => {
  const admin = createBot(db, "Kit");
  const client = await connect(admin.key);
  const product = await call(client, "create_product", {
    key: projectKey(),
    name: "a product",
  });
  expect(product.kind).toBe("product");
  const team = await call(client, "create_product", {
    key: projectKey(),
    name: "a team for another bot",
    kind: "team",
    owner: null,
  });
  expect(team.kind).toBe("team");

  const changed = await call(client, "update_product", {
    product: product.key,
    kind: "team",
  });
  expect(changed).toMatchObject({ key: product.key, kind: "team" });
  expect(
    await call(client, "get_product", { product: product.key }),
  ).toMatchObject({ kind: "team" });
  await call(client, "update_product", {
    product: product.key,
    kind: "product",
  });

  const keysOf = (page: Body) =>
    (page.items as { key: string }[]).map((p) => p.key);
  const teams = await call(client, "list_products", {
    kind: "team",
    limit: 200,
  });
  expect(keysOf(teams)).toContain(team.key);
  expect(keysOf(teams)).not.toContain(product.key);
  expect(teams.items.every((p: { kind: string }) => p.kind === "team")).toBe(
    true,
  );
  const products = await call(client, "list_products", {
    kind: "product",
    limit: 200,
  });
  expect(keysOf(products)).toContain(product.key);
  expect(keysOf(products)).not.toContain(team.key);
});

test("update_product's kind needs the admin action like any of its fields", async () => {
  const admin = createBot(db, "Kade");
  const product = await call(await connect(admin.key), "create_product", {
    key: projectKey(),
    name: "stays a product",
  });
  const worker = createKey(db, admin.actor.id, { actions: ["read", "issues"] });
  expect(
    await callError(await connect(worker.key), "update_product", {
      product: product.key,
      kind: "team",
    }),
  ).toMatch(
    /^forbidden_action: this key may not update a product: that needs the admin action/,
  );
});
