import { expect, test } from "vitest";
import { createBot, revokeKey } from "../service/keys.js";
import { atFakeTime, setupTestApp } from "../test-app.js";

const { db, bot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

test("GET /whoami answers the key's bot: id, kind, name, label, photoUrl and title", async () => {
  const labelled = createBot(db, "rest whoami", { label: "agent-7" });
  const res = await request("GET", "/api/v1/whoami", { key: labelled.key });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    id: labelled.actor.id,
    kind: "bot",
    name: "rest whoami",
    label: "agent-7",
    scope: { products: null, projects: null, actions: null },
    ownProducts: [],
    products: [],
    photoUrl: null,
    title: null,
    unreadMessages: 0,
  });
});

test("GET /whoami lists the products the bot owns and every product its key reaches", async () => {
  const owner = createBot(db, "rest owner");
  const made = async (key: string) =>
    (
      await request("POST", "/api/v1/products", {
        json: { key, name: key.toLowerCase() },
        key: owner.key,
      })
    ).json();
  await made("WHOA");
  await request("POST", "/api/v1/products", {
    json: { key: "WHOB", name: "whob", owner: null },
    key: owner.key,
  });
  const scoped = createBot(db, "rest scoped", {
    scope: { products: ["WHOB"] },
  });
  const me = (await (
    await request("GET", "/api/v1/whoami", { key: owner.key })
  ).json()) as Body;
  expect(me.ownProducts).toEqual([{ key: "WHOA", name: "whoa" }]);
  expect(me.products).toEqual([
    { key: "WHOA", name: "whoa" },
    { key: "WHOB", name: "whob" },
  ]);
  const limited = (await (
    await request("GET", "/api/v1/whoami", { key: scoped.key })
  ).json()) as Body;
  expect(limited).toMatchObject({
    scope: { products: ["WHOB"], projects: [] },
    ownProducts: [],
    products: [{ key: "WHOB", name: "whob" }],
  });
});

test("GET /bots pages every bot oldest first with id, name, label photoUrl and title only", async () => {
  const [first, labelled] = atFakeTime([
    () => createBot(db, "rest listed first"),
    () => createBot(db, "rest listed", { label: "agent-8" }),
  ]) as [ReturnType<typeof createBot>, ReturnType<typeof createBot>];
  const items: Body[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${cursor}` : "";
    const res = await request("GET", `/api/v1/bots?limit=1${query}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    items.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  const ids = items.map((i) => i.id);
  expect(ids).toContain(first.actor.id);
  expect(ids.indexOf(first.actor.id)).toBeLessThan(
    ids.indexOf(labelled.actor.id),
  );
  expect(items.find((i) => i.id === labelled.actor.id)).toEqual({
    id: labelled.actor.id,
    name: "rest listed",
    label: "agent-8",
    photoUrl: null,
    title: null,
  });
  expect(ids).toContain(bot.actor.id);
  for (const item of items) {
    expect(Object.keys(item).sort()).toEqual([
      "id",
      "label",
      "name",
      "photoUrl",
      "title",
    ]);
  }
});

test("GET /whoami and GET /bots without a key are 401s", async () => {
  for (const path of ["/api/v1/whoami", "/api/v1/bots"]) {
    expect((await request("GET", path, { key: null })).status, path).toBe(401);
  }
});

test("GET /bots with a bad cursor is a 422", async () => {
  const res = await request("GET", "/api/v1/bots?cursor=nope");
  expect(res.status).toBe(422);
});

test("GET /bots takes limit 1 to 200 and refuses 0 and 201 with a 422", async () => {
  for (const limit of [1, 200]) {
    const res = await request("GET", `/api/v1/bots?limit=${limit}`);
    expect(res.status, `limit ${limit}`).toBe(200);
  }
  for (const limit of [0, 201]) {
    const res = await request("GET", `/api/v1/bots?limit=${limit}`);
    expect(res.status, `limit ${limit}`).toBe(422);
  }
});

test("GET /whoami with a revoked key or a garbage key is a 401", async () => {
  const revoked = createBot(db, "rest revoked");
  expect(
    (await request("GET", "/api/v1/whoami", { key: revoked.key })).status,
  ).toBe(200);
  revokeKey(db, revoked.key.split("_")[1] as string);
  expect(
    (await request("GET", "/api/v1/whoami", { key: revoked.key })).status,
  ).toBe(401);
  expect(
    (await request("GET", "/api/v1/whoami", { key: "trl_garbage_nope" }))
      .status,
  ).toBe(401);
});

test("GET /whoami shows a project-only key's projects by slug, an empty products list, and the products its project draws from", async () => {
  await request("POST", "/api/v1/products", {
    json: { key: "WHOC", name: "whoc", owner: null },
  });
  const made = await request("POST", "/api/v1/projects", {
    json: { name: "Who recon", slug: "who-recon", products: ["WHOC"] },
  });
  expect(made.status).toBe(201);
  const scoped = createBot(db, "rest project scoped", {
    scope: { projects: ["who-recon"] },
  });
  const me = (await (
    await request("GET", "/api/v1/whoami", { key: scoped.key })
  ).json()) as Body;
  expect(me).toMatchObject({
    scope: { products: [], projects: ["who-recon"], actions: null },
    ownProducts: [],
    products: [{ key: "WHOC", name: "whoc" }],
  });
});
