import { beforeAll, expect, test } from "vitest";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, bot, request, inviteEmail, signInWithEmail } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const JUSTIN = "justin.handled@example.com";
const handled = createBot(db, "handled bot");
const unhandled = createBot(db, "unhandled bot");

beforeAll(async () => {
  inviteEmail(JUSTIN);
  await signInWithEmail(JUSTIN);
  setBotHandler(db, handled.actor.id, JUSTIN);
});

const get = async (path: string, key: string) =>
  (await (await request("GET", path, { key })).json()) as Body;

test("whoami shows the calling bot's handler with name and email, and null without one", async () => {
  expect((await get("/api/v1/whoami", handled.key)).handler).toEqual({
    name: "justin.handled",
    email: JUSTIN,
  });
  expect((await get("/api/v1/whoami", unhandled.key)).handler).toBeNull();
});

test("GET /bots shows each bot's handler by name alone, and null without one", async () => {
  const { items } = await get("/api/v1/bots?limit=100", bot.key);
  const byId = (id: string) => items.find((b: Body) => b.id === id);
  expect(byId(handled.actor.id).handler).toEqual({ name: "justin.handled" });
  expect(byId(unhandled.actor.id).handler).toBeNull();
});

const fileIssue = (key: string, json: Body, headers?: Record<string, string>) =>
  request("POST", "/api/v1/items", {
    key,
    json: { type: "issue", product: "HND", title: "for someone", ...json },
    headers,
  });

test("an issue filed with filed_for handler is filed for the bot's handler, by name; left out, for nobody", async () => {
  await request("POST", "/api/v1/products", {
    key: bot.key,
    json: { key: "HND", name: "handled product" },
  });
  const res = await fileIssue(handled.key, { filed_for: "handler" });
  expect(res.status).toBe(201);
  const filed = (await res.json()) as Body;
  expect(filed.filedFor).toEqual({ name: "justin.handled" });
  expect((await get(`/api/v1/items/${filed.key}`, bot.key)).filedFor).toEqual({
    name: "justin.handled",
  });
  const own = (await (await fileIssue(handled.key, {})).json()) as Body;
  expect(own.filedFor).toBeNull();
});

test("filed_for handler from a bot with no handler is a 422 naming the command that sets one", async () => {
  const res = await fileIssue(unhandled.key, { filed_for: "handler" });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toBe(
    'filed_for "handler" files the issue for the person you work for, and you have no handler: leave filed_for out to file it as your own, or ask the operator to set one with `trail bot handler "unhandled bot" <email>`',
  );
});

test("filed_for on a todo or a note is a 422, the legacy create's todo included", async () => {
  for (const json of [
    { type: "todo", filed_for: "handler" },
    { type: "note", filed_for: "handler" },
  ]) {
    const res = await fileIssue(bot.key, json);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.message).toMatch(
      /^filed_for is an issue's field, the person an issue is filed for: leave it out of a (todo|note)/,
    );
  }
  // the bot owns HND, so its legacy create makes a todo
  const legacy = await request("POST", "/api/v1/issues", {
    key: bot.key,
    json: { projectId: "HND", title: "own", filed_for: "handler" },
  });
  expect(legacy.status).toBe(422);
});

test("the legacy create files an issue for the handler", async () => {
  const res = await request("POST", "/api/v1/issues", {
    key: handled.key,
    json: { projectId: "HND", title: "legacy", filed_for: "handler" },
  });
  expect(res.status).toBe(201);
  expect(((await res.json()) as Body).filedFor).toEqual({
    name: "justin.handled",
  });
});

test("a retry with the same Idempotency-Key replays the original, and with another filed_for is a mismatch", async () => {
  const headers = { "idempotency-key": "filed-for-retry" };
  const first = (await (
    await fileIssue(handled.key, { filed_for: "handler" }, headers)
  ).json()) as Body;
  setBotHandler(db, handled.actor.id, null);
  const replay = await fileIssue(
    handled.key,
    { filed_for: "handler" },
    headers,
  );
  expect(replay.status).toBe(201);
  expect(((await replay.json()) as Body).key).toBe(first.key);
  const mismatch = await fileIssue(handled.key, {}, headers);
  expect(mismatch.status).toBe(422);
  expect(((await mismatch.json()) as Body).error.code).toBe(
    "idempotency_key_reused",
  );
  setBotHandler(db, handled.actor.id, JUSTIN);
});

test("filedFor sent as an argument is a 422 saying to send filed_for, the name items answer with being filedFor", async () => {
  const res = await fileIssue(handled.key, { filedFor: "handler" });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toContain(
    'Unrecognized key "filedFor": the argument is filed_for, so send filed_for instead; filedFor is the field items answer with',
  );
});
