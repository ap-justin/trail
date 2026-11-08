import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

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
  const labelled = createBot(db, "rest listed", { label: "agent-8" });
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
  expect(items[0]).toEqual({ id: bot.actor.id, name: "tester", label: null });
  expect(items.at(-1)).toEqual({
    id: labelled.actor.id,
    name: "rest listed",
    label: "agent-8",
  });
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
