import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { webhookSubscription } from "../db/schema.js";
import { createBot, createKey } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const sent: { url: string; headers: Record<string, string>; body: string }[] =
  [];
let answer = 200;
const { db, request, addProject, addBot } = setupTestApp({
  webhooks: {
    transport: async ({ url, headers, body }) => {
      sent.push({ url: url.href, headers, body });
      return { status: answer };
    },
  },
});

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const SECRET = "whsec_0123456789abcdef-the-first-secret";
const NEW_SECRET = "whsec_fedcba9876543210-the-second-secret";
const HOOK = "https://bot.example.com/hooks/trail";

const a = addProject("A");
const b = addProject("B");

// every body this file reads, to prove no secret ever shows in one
const seen: string[] = [];
async function call(
  method: string,
  path: string,
  { json, key }: { json?: unknown; key?: string } = {},
) {
  const res = await request(method, `/api/v1${path}`, { json, key });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, text, body: JSON.parse(text) as Body };
}

const create = (json: Body = {}, key?: string) =>
  call("POST", "/webhooks", {
    json: { url: HOOK, secret: SECRET, projects: [a.key], ...json },
    key,
  });

test("a bot creates, lists, reads, updates, rotates and deletes a webhook", async () => {
  const created = await create();
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    url: HOOK,
    projects: [a.key],
    paused: false,
    pausedAt: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  const id = created.body.id as string;

  const listed = await call("GET", "/webhooks");
  expect(listed.body.items.map((w: Body) => w.id)).toEqual([id]);
  expect(listed.body.nextCursor).toBeNull();
  expect((await call("GET", `/webhooks/${id}`)).body.id).toBe(id);

  const moved = await call("PATCH", `/webhooks/${id}`, {
    json: { projects: [a.key, b.key.toLowerCase()] },
  });
  expect(moved.body.projects).toEqual([a.key, b.key].sort());

  const rotated = await call("PUT", `/webhooks/${id}/secret`, {
    json: { secret: NEW_SECRET },
  });
  expect(rotated.status).toBe(200);
  expect(rotated.body.id).toBe(id);

  expect(await call("DELETE", `/webhooks/${id}`)).toMatchObject({
    status: 200,
    body: { deleted: true },
  });
  expect((await call("GET", `/webhooks/${id}`)).status).toBe(404);
  expect((await call("GET", "/webhooks")).body.items).toEqual([]);
});

test("the secret is never returned, listed or stored as given", async () => {
  const id = (await create({ url: "https://bot.example.com/secret" })).body.id;
  await call("PUT", `/webhooks/${id}/secret`, { json: { secret: NEW_SECRET } });
  await call("POST", `/webhooks/${id}/ping`);
  await call("GET", "/webhooks");
  // a refusal of the secret itself doesn't echo it either
  const tooShort = await create({
    url: "https://bot.example.com/s2",
    secret: "short",
  });
  expect(tooShort.status).toBe(422);
  for (const text of seen) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(NEW_SECRET);
    expect(text).not.toContain('short"');
  }
  const stored = db.select().from(webhookSubscription).all();
  expect(stored.length).toBeGreaterThan(0);
  for (const row of stored) {
    expect(JSON.stringify(row)).not.toContain(SECRET.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(NEW_SECRET.slice(0, 12));
  }
  await call("DELETE", `/webhooks/${id}`);
});

test("a webhook belongs to the bot, so a new key keeps it", async () => {
  const carol = addBot("carol");
  const made = await create(
    { url: "https://bot.example.com/carol" },
    carol.key,
  );
  expect(made.status).toBe(201);
  // a further key of the same actor
  const next = createKey(db, carol.actor.id).key;
  const listed = await call("GET", "/webhooks", { key: next });
  expect(listed.body.items.map((w: Body) => w.id)).toEqual([made.body.id]);
});

test("a bot sees, changes, tests and deletes only its own webhooks", async () => {
  const mine = (await create({ url: "https://bot.example.com/mine" })).body.id;
  const other = addBot("dave");
  const theirs = (
    await create({ url: "https://bot.example.com/theirs" }, other.key)
  ).body.id;
  expect(
    (await call("GET", "/webhooks", { key: other.key })).body.items.map(
      (w: Body) => w.id,
    ),
  ).toEqual([theirs]);
  for (const [method, path, json] of [
    ["GET", `/webhooks/${mine}`, undefined],
    ["PATCH", `/webhooks/${mine}`, { projects: [a.key] }],
    ["PUT", `/webhooks/${mine}/secret`, { secret: NEW_SECRET }],
    ["POST", `/webhooks/${mine}/ping`, undefined],
    ["DELETE", `/webhooks/${mine}`, undefined],
  ] as const) {
    const res = await call(method, path, { json, key: other.key });
    expect(res.status, `${method} ${path}`).toBe(404);
  }
  // an unknown id reads the same
  const missing = await call("DELETE", "/webhooks/no-such-webhook", {
    key: other.key,
  });
  const foreign = await call("DELETE", `/webhooks/${mine}`, { key: other.key });
  expect(foreign.body).toEqual({
    error: {
      code: "not_found",
      message: missing.body.error.message.replace("no-such-webhook", mine),
    },
  });
  // and the owner still has it
  expect((await call("GET", `/webhooks/${mine}`)).status).toBe(200);
});

test("a key limited to one project can't subscribe to another: a 404, as for a missing project", async () => {
  const scoped = createBot(db, "bg-ivy", {
    scope: { projects: [a.key], actions: ["read", "issues"] },
  });
  const hidden = await create({ projects: [b.key] }, scoped.key);
  const missing = await create({ projects: ["NOPE9"] }, scoped.key);
  expect(hidden.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(hidden.body.error.code).toBe("not_found");
  expect(hidden.body.error.message.replace(b.key, "X")).toBe(
    missing.body.error.message.replace("NOPE9", "X"),
  );
  const ok = await create({ url: "https://bot.example.com/ivy" }, scoped.key);
  expect(ok.status).toBe(201);
  // the broader key of the same... another bot's wider webhook is invisible to ivy
  const wide = await create({
    url: "https://bot.example.com/wide",
    projects: [a.key, b.key],
  });
  const ivyList = (await call("GET", "/webhooks", { key: scoped.key })).body
    .items;
  expect(ivyList.map((w: Body) => w.id)).toEqual([ok.body.id]);
  expect(wide.status).toBe(201);
});

test("a webhook the key's scope doesn't fully cover is missing to that key", async () => {
  const wideBot = createBot(db, "wide-bot");
  const wide = await create(
    { projects: [a.key, b.key], url: "https://bot.example.com/w2" },
    wideBot.key,
  );
  expect(wide.status).toBe(201);
  const narrow = createKey(db, wideBot.actor.id, { projects: [a.key] }).key;
  expect((await call("GET", "/webhooks", { key: narrow })).body.items).toEqual(
    [],
  );
  expect(
    (await call("DELETE", `/webhooks/${wide.body.id}`, { key: narrow })).status,
  ).toBe(404);
});

test("a key without the read action is refused", async () => {
  const writer = createBot(db, "writer", { scope: { actions: ["issues"] } });
  const res = await create(
    { url: "https://bot.example.com/writer" },
    writer.key,
  );
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe("forbidden_action");
  expect((await call("GET", "/webhooks", { key: writer.key })).status).toBe(
    403,
  );
});

test.each([
  ["https://127.0.0.1/hook"],
  ["https://10.0.0.1/hook"],
  ["https://[::1]/hook"],
  ["https://169.254.169.254/latest/meta-data"],
  ["http://bot.example.com/hook"],
  ["https://internal.example.test/hook"],
  ["https://user:pw@bot.example.com/hook"],
])("%s is refused at create with a 422", async (url) => {
  const res = await create({ url });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("validation_failed");
});

test("an update to an internal URL is refused too", async () => {
  const id = (await create({ url: "https://bot.example.com/upd" })).body.id;
  const res = await call("PATCH", `/webhooks/${id}`, {
    json: { url: "https://10.0.0.1/hook" },
  });
  expect(res.status).toBe(422);
  expect((await call("GET", `/webhooks/${id}`)).body.url).toBe(
    "https://bot.example.com/upd",
  );
});

test("the same URL twice is a 409 naming the first", async () => {
  const first = await create({ url: "https://bot.example.com/dup" });
  const again = await create({ url: "https://bot.example.com/dup" });
  expect(again.status).toBe(409);
  expect(again.body.error.message).toContain(first.body.id);
});

test("an empty projects list and an unknown field are 422s", async () => {
  expect((await create({ projects: [] })).status).toBe(422);
  expect((await create({ extra: 1 })).status).toBe(422);
});

test("the ping is a signed trail.ping the receiver can verify, and reports its answer", async () => {
  const id = (await create({ url: "https://bot.example.com/ping" })).body.id;
  sent.length = 0;
  answer = 200;
  const ok = await call("POST", `/webhooks/${id}/ping`);
  expect(ok.body).toEqual({ delivered: true, status: 200, error: null });
  const [ping] = sent;
  expect(ping?.url).toBe("https://bot.example.com/ping");
  const message = JSON.parse(ping?.body ?? "");
  expect(message.type).toBe("trail.ping");
  expect(Number.isNaN(Date.parse(message.occurredAt))).toBe(false);
  const h = ping?.headers ?? {};
  expect(h["content-type"]).toBe("application/json");
  const expected = createHmac("sha256", SECRET)
    .update(
      `${h["x-openbot-timestamp"]}.${h["x-openbot-delivery-id"]}.${ping?.body}`,
    )
    .digest("hex");
  expect(h["x-openbot-signature"]).toBe(`sha256=${expected}`);

  answer = 503;
  const bad = await call("POST", `/webhooks/${id}/ping`);
  expect(bad.body).toEqual({
    delivered: false,
    status: 503,
    error: "HTTP 503",
  });
  answer = 200;
});

test("a rotated secret signs the next ping", async () => {
  const id = (await create({ url: "https://bot.example.com/rot" })).body.id;
  await call("PUT", `/webhooks/${id}/secret`, { json: { secret: NEW_SECRET } });
  sent.length = 0;
  await call("POST", `/webhooks/${id}/ping`);
  const h = sent[0]?.headers ?? {};
  const signed = (secret: string) =>
    `sha256=${createHmac("sha256", secret).update(`${h["x-openbot-timestamp"]}.${h["x-openbot-delivery-id"]}.${sent[0]?.body}`).digest("hex")}`;
  expect(h["x-openbot-signature"]).toBe(signed(NEW_SECRET));
  expect(h["x-openbot-signature"]).not.toBe(signed(SECRET));
});

test("the spec explains the set-up and carries no secret in any response schema", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<string, Record<string, { description?: string }>>;
    components: { schemas: Record<string, { properties?: object }> };
  };
  const description = spec.paths["/webhooks"]?.post?.description ?? "";
  expect(description).toContain("OpenBot webhook routine");
  expect(description).toContain("Never paste the secret into chat");
  expect(description).toContain("x-openbot-signature");
  expect(
    Object.keys(spec.components.schemas.Webhook?.properties ?? {}),
  ).not.toContain("secret");
});
