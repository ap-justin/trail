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
    `conflict: you already own team ${first.key}, and a bot creates at most one team itself: keep your own work there (add_todo, add_note with product ${first.key}); an admin creates more products or teams with create_product (POST /products)`,
  );
  const listed = await call(bot.client, "list_products", { limit: 200 });
  expect(listed.items.map((p: { key: string }) => p.key)).not.toContain(second);
});

test("create_team: a bot that owns a product its key reaches is refused, pointed at that product", async () => {
  const admin = createBot(db, "Petra");
  const client = await connect(admin.key);
  const product = await call(client, "create_product", {
    key: projectKey(),
    name: "Petra's product",
  });
  expect(
    await callError(client, "create_team", {
      key: projectKey(),
      name: "a team too",
    }),
  ).toBe(
    `conflict: you own product ${product.key}, and a team is only for a bot that owns no product or team: keep your own work in ${product.key} (add_todo, add_note with product ${product.key}); an admin creates more products or teams with create_product (POST /products)`,
  );
});

test("create_team: a bot that owns a product its key doesn't reach is refused without the product's key, and told whom to ask", async () => {
  const admin = createBot(db, "Perrin");
  const product = await call(await connect(admin.key), "create_product", {
    key: projectKey(),
    name: "Perrin's product",
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
  const refusal = await callError(await connect(narrow.key), "create_team", {
    key: projectKey(),
    name: "a team too",
  });
  expect(refusal).toBe(
    "conflict: you own a product this key doesn't reach, and a team is only for a bot that owns no product or team: ask whoever minted the key to add your product to it and keep your own work there, or ask an admin, who creates more products or teams with create_product (POST /products)",
  );
  expect(refusal).not.toContain(product.key);
});

test("create_team: a bot whose team its key doesn't reach is refused without the team's key", async () => {
  const bot = await newcomer("Tess");
  const team = await call(bot.client, "create_team", {
    key: projectKey(),
    name: "Tess's desk",
  });
  const admin = createBot(db, "Tess's admin");
  const other = await call(await connect(admin.key), "create_product", {
    key: projectKey(),
    name: "other",
    owner: null,
  });
  const later = createKey(db, bot.actor.id, {
    products: [other.key],
    actions: ["read", "issues"],
  });
  const refusal = await callError(await connect(later.key), "create_team", {
    key: projectKey(),
    name: "again",
  });
  expect(refusal).toBe(
    "conflict: you already own a team this key doesn't reach, and a bot creates at most one team itself: ask whoever minted the key to add your team to it, or ask an admin, who creates more products or teams with create_product (POST /products)",
  );
  expect(refusal).not.toContain(team.key);
});

test("create_team with a taken key says so without naming the product holding it", async () => {
  const admin = createBot(db, "Hidden Owner");
  const hidden = await call(await connect(admin.key), "create_product", {
    key: projectKey(),
    name: "a secret product name",
    owner: null,
  });
  const bot = await newcomer("Peeker");
  const refusal = await callError(bot.client, "create_team", {
    key: hidden.key,
    name: "peek",
  });
  expect(refusal).toBe(
    `conflict: product key ${hidden.key} is taken: choose another key`,
  );
  expect(refusal).not.toContain("secret");
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

test("create_team: a key limited only to projects is refused before anything is written, since it could not reach the team", async () => {
  const admin = createBot(db, "Pia");
  const adminClient = await connect(admin.key);
  const shared = await call(adminClient, "create_product", {
    key: projectKey(),
    name: "pia's shared",
    owner: null,
  });
  const project = await call(adminClient, "create_project", {
    name: "pia's project",
    products: [shared.key],
  });
  const bot = createBot(db, "Quill", {
    scope: { projects: [project.slug], actions: ["read", "issues"] },
  });
  const client = await connect(bot.key);
  const key = projectKey();
  expect(await callError(client, "create_team", { key, name: "nowhere" })).toBe(
    `forbidden_scope: this key may not create a team: it reaches only project ${project.slug}, so it could not work in a team. Ask whoever minted the key for one with a product list, or with no product limit, and create the team with that.`,
  );
  expect((await call(client, "whoami")).team).toBeNull();
  const unlimited = createKey(db, bot.actor.id);
  const listed = await call(await connect(unlimited.key), "list_products", {
    limit: 200,
  });
  expect(listed.items.map((p: { key: string }) => p.key)).not.toContain(key);
});

test("whoami's hint offers create_team only to a key that can use it, and otherwise says what key to ask for", async () => {
  const admin = createBot(db, "Hint admin");
  const adminClient = await connect(admin.key);
  const shared = await call(adminClient, "create_product", {
    key: projectKey(),
    name: "hint shared",
    owner: null,
  });
  const project = await call(adminClient, "create_project", {
    name: "hint project",
    products: [shared.key],
  });
  const hintOf = async (scope: Parameters<typeof createBot>[2]) => {
    const made = createBot(db, `hint ${projectKey()}`, scope);
    return (await call(await connect(made.key), "whoami")).hint;
  };
  expect(
    await hintOf({
      scope: { projects: [project.slug], actions: ["read", "issues"] },
    }),
  ).toBe(
    "You own no product and no team, and this key reaches only projects, so it can't create your team: ask whoever minted it for a key with a product list. Write records with add_note; to ask a product's bot for work, file an issue on its product with file_issue.",
  );
  expect(await hintOf({ scope: { actions: ["read", "comments"] } })).toBe(
    "You own no product and no team, and this key lacks the issues action, so it can't create your team, add notes or file issues: ask whoever minted it for a key with the issues action.",
  );
  expect(
    await hintOf({ scope: { projects: [project.slug], actions: ["read"] } }),
  ).toBe(
    "You own no product and no team, and this key lacks the issues action, so it can't create your team, add notes or file issues: ask whoever minted it for a key with the issues action and a product list.",
  );
});

test("list_products with kind leaves out the products a key reaches only through a project, so their kind stays hidden", async () => {
  const admin = createBot(db, "Kind admin");
  const adminClient = await connect(admin.key);
  const hiddenTeam = await call(adminClient, "create_product", {
    key: projectKey(),
    name: "hidden team",
    kind: "team",
    owner: null,
  });
  const hiddenProduct = await call(adminClient, "create_product", {
    key: projectKey(),
    name: "hidden product",
    owner: null,
  });
  const project = await call(adminClient, "create_project", {
    name: "kind window",
    products: [hiddenTeam.key, hiddenProduct.key],
  });
  const viewer = createBot(db, "Kind viewer", {
    scope: { projects: [project.slug] },
  });
  const client = await connect(viewer.key);
  const keys = async (args: Body) =>
    (
      (await call(client, "list_products", { limit: 200, ...args })).items as {
        key: string;
      }[]
    ).map((p) => p.key);

  expect(await keys({})).toEqual(
    expect.arrayContaining([hiddenTeam.key, hiddenProduct.key]),
  );
  for (const kind of ["team", "product"]) {
    const filtered = await keys({ kind });
    expect(filtered, kind).not.toContain(hiddenTeam.key);
    expect(filtered, kind).not.toContain(hiddenProduct.key);
  }
});
