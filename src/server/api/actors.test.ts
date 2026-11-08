import { expect, test } from "vitest";
import { createBot, revokeKey } from "../service/keys.js";
import { atFakeTime, setupTestApp } from "../test-app.js";

const { db, bot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

test("GET /whoami answers the key's bot: id, kind, name and label", async () => {
  const labelled = createBot(db, "rest whoami", { label: "agent-7" });
  const res = await request("GET", "/api/v1/whoami", { key: labelled.key });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    id: labelled.actor.id,
    kind: "bot",
    name: "rest whoami",
    label: "agent-7",
  });
});

test("GET /bots pages every bot oldest first with id, name and label only", async () => {
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
  expect(ids.indexOf(first.actor.id)).toBe(0);
  expect(ids.indexOf(labelled.actor.id)).toBe(1);
  expect(items[1]).toEqual({
    id: labelled.actor.id,
    name: "rest listed",
    label: "agent-8",
  });
  expect(ids).toContain(bot.actor.id);
  for (const item of items) {
    expect(Object.keys(item).sort()).toEqual(["id", "label", "name"]);
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
