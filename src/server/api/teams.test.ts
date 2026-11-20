import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, request } = setupTestApp();

/** A bot that owns nothing, on a key with the issues action and no admin. */
const newcomer = (name: string) =>
  createBot(db, name, { scope: { actions: ["read", "issues", "comments"] } });

test("POST /teams creates the caller's team with 201; a retry under the same Idempotency-Key returns it, and a second team is a 409", async () => {
  const bot = newcomer("Tova");
  const key = projectKey();
  const send = (json: unknown, idempotencyKey?: string) =>
    request("POST", "/api/v1/teams", {
      json,
      key: bot.key,
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    });

  const res = await send({ key, name: "Tova's desk" }, "tova-1");
  expect(res.status).toBe(201);
  const team = await res.json();
  expect(team).toMatchObject({
    key,
    name: "Tova's desk",
    kind: "team",
    description: "",
    owner: { id: bot.actor.id, name: "Tova", kind: "bot" },
  });

  const retry = await send({ key, name: "Tova's desk" }, "tova-1");
  expect(retry.status).toBe(201);
  expect(await retry.json()).toEqual(team);

  const second = await send({ key: projectKey(), name: "another" });
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({
    error: {
      code: "conflict",
      message: `you already own team ${key}, and a bot creates at most one team itself: keep your own work there (add_todo, add_note with product ${key}); an admin creates more products or teams with create_product (POST /products)`,
    },
  });
});

test("POST /teams without the issues action is a 403", async () => {
  const reader = createBot(db, "Rufus", { scope: { actions: ["read"] } });
  const res = await request("POST", "/api/v1/teams", {
    json: { key: projectKey(), name: "nope" },
    key: reader.key,
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({
    error: { code: "forbidden_action" },
  });
});

test("POST /teams refuses a field it doesn't take, like owner", async () => {
  const bot = newcomer("Fenna");
  const res = await request("POST", "/api/v1/teams", {
    json: { key: projectKey(), name: "x", owner: "tester" },
    key: bot.key,
  });
  expect(res.status).toBe(422);
});

test("POST and PATCH /products take kind, and GET /products filters on it", async () => {
  const created = await request("POST", "/api/v1/products", {
    json: {
      key: projectKey(),
      name: "admin's team",
      kind: "team",
      owner: null,
    },
  });
  expect(created.status).toBe(201);
  const team = (await created.json()) as { key: string; kind: string };
  expect(team.kind).toBe("team");

  const plain = (await (
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "plain" },
    })
  ).json()) as { key: string; kind: string };
  expect(plain.kind).toBe("product");

  const patched = await request("PATCH", `/api/v1/products/${plain.key}`, {
    json: { kind: "team" },
  });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ kind: "team" });
  await request("PATCH", `/api/v1/products/${plain.key}`, {
    json: { kind: "product" },
  });

  const keys = async (query: string) =>
    (
      (await (
        await request("GET", `/api/v1/products?limit=200${query}`)
      ).json()) as { items: { key: string }[] }
    ).items.map((p) => p.key);
  expect(await keys("&kind=team")).toContain(team.key);
  expect(await keys("&kind=team")).not.toContain(plain.key);
  expect(await keys("&kind=product")).toContain(plain.key);
  expect(await keys("&kind=product")).not.toContain(team.key);
  expect(await keys("")).toEqual(expect.arrayContaining([team.key, plain.key]));

  const wrong = await request("GET", "/api/v1/products?kind=crew");
  expect(wrong.status).toBe(422);
});

test("GET /whoami carries team and, for a bot that owns nothing, hint", async () => {
  const bot = newcomer("Wyn");
  const before = await (
    await request("GET", "/api/v1/whoami", { key: bot.key })
  ).json();
  expect(before).toMatchObject({
    team: null,
    hint: expect.stringContaining("create_team"),
  });
  const key = projectKey();
  await request("POST", "/api/v1/teams", {
    json: { key, name: "Wyn's desk" },
    key: bot.key,
  });
  const after = (await (
    await request("GET", "/api/v1/whoami", { key: bot.key })
  ).json()) as { team: unknown };
  expect(after.team).toEqual({ key, name: "Wyn's desk" });
  expect(after).not.toHaveProperty("hint");
});

test("POST /teams with a key limited only to projects is a 403 forbidden_scope, and no team is written", async () => {
  const shared = (await (
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "rest shared", owner: null },
    })
  ).json()) as { key: string };
  const project = (await (
    await request("POST", "/api/v1/projects", {
      json: { name: "rest project", products: [shared.key] },
    })
  ).json()) as { slug: string };
  const bot = createBot(db, "Sorrel", {
    scope: { projects: [project.slug], actions: ["read", "issues"] },
  });
  const res = await request("POST", "/api/v1/teams", {
    json: { key: projectKey(), name: "nowhere" },
    key: bot.key,
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: {
      code: "forbidden_scope",
      message: `this key may not create a team: it reaches only project ${project.slug}, so it could not work in a team. Ask whoever minted the key for one with a product list, or with no product limit, and create the team with that.`,
    },
  });
  const me = (await (
    await request("GET", "/api/v1/whoami", { key: bot.key })
  ).json()) as { team: unknown };
  expect(me.team).toBeNull();
});

test("POST /teams with a taken key is a 409 that doesn't name the product holding it", async () => {
  const hidden = (await (
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "a secret rest product", owner: null },
    })
  ).json()) as { key: string };
  const bot = newcomer("Rest Peeker");
  const res = await request("POST", "/api/v1/teams", {
    json: { key: hidden.key, name: "peek" },
    key: bot.key,
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: {
      code: "conflict",
      message: `product key ${hidden.key} is taken: choose another key`,
    },
  });
});

test("GET /products?kind= leaves out products the key reaches only through a project", async () => {
  const create = async (json: object) =>
    (await (await request("POST", "/api/v1/products", { json })).json()) as {
      key: string;
    };
  const team = await create({
    key: projectKey(),
    name: "rest hidden team",
    kind: "team",
    owner: null,
  });
  const plain = await create({
    key: projectKey(),
    name: "rest hidden product",
    owner: null,
  });
  const project = (await (
    await request("POST", "/api/v1/projects", {
      json: { name: "rest kind window", products: [team.key, plain.key] },
    })
  ).json()) as { slug: string };
  const viewer = createBot(db, "Rest kind viewer", {
    scope: { projects: [project.slug] },
  });
  const keys = async (query: string) =>
    (
      (await (
        await request("GET", `/api/v1/products?limit=200${query}`, {
          key: viewer.key,
        })
      ).json()) as { items: { key: string }[] }
    ).items.map((p) => p.key);
  expect(await keys("")).toEqual(expect.arrayContaining([team.key, plain.key]));
  for (const kind of ["team", "product"]) {
    const filtered = await keys(`&kind=${kind}`);
    expect(filtered, kind).not.toContain(team.key);
    expect(filtered, kind).not.toContain(plain.key);
  }
});
