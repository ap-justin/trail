import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import { webhookSubscription } from "../db/schema.js";
import { createBot, createKey } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const sent: { url: string; headers: Record<string, string>; body: string }[] =
  [];
let answer = 200;
let resolveTo = ["93.184.216.34"];
// while set, every DNS lookup waits on it: requests pile up inside the lookup's await
let dnsGate: Promise<void> | null = null;
let lookups = 0;
const holdDns = () => {
  let release = () => {};
  dnsGate = new Promise((r) => {
    release = r;
  });
  return release;
};
const { db, request, addProject, addBot, addMember, signIn, owner } =
  setupTestApp({
    webhooks: {
      resolve: async (host) => {
        lookups++;
        await dnsGate;
        return host === "internal.example.test" ? ["10.0.0.5"] : resolveTo;
      },
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

// every test starts with no webhooks, so none depends on the ones before it or counts toward the bot's limit
beforeEach(() => {
  db.delete(webhookSubscription).run();
  sent.length = 0;
  answer = 200;
  resolveTo = ["93.184.216.34"];
  dnsGate = null;
  lookups = 0;
});

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
  // another bot's wider webhook is invisible to ivy
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

test("moving a webhook onto another of the bot's URLs is a 409 naming it; its own URL, or another bot's, is fine", async () => {
  const first = (await create({ url: "https://bot.example.com/one" })).body.id;
  const second = (await create({ url: "https://bot.example.com/two" })).body.id;
  const onto = await call("PATCH", `/webhooks/${second}`, {
    json: { url: "https://bot.example.com/one" },
  });
  expect(onto.status).toBe(409);
  expect(onto.body.error.message).toContain(first);
  // the host is case-insensitive, so this is the same URL
  const shouted = await call("PATCH", `/webhooks/${second}`, {
    json: { url: "https://BOT.example.com/one" },
  });
  expect(shouted.status).toBe(409);
  expect((await call("GET", `/webhooks/${second}`)).body.url).toBe(
    "https://bot.example.com/two",
  );

  const same = await call("PATCH", `/webhooks/${second}`, {
    json: { url: "https://bot.example.com/two" },
  });
  expect(same.status).toBe(200);

  const other = addBot("erin");
  const theirs = (
    await create({ url: "https://bot.example.com/elsewhere" }, other.key)
  ).body.id;
  const shared = await call("PATCH", `/webhooks/${theirs}`, {
    json: { url: "https://bot.example.com/one" },
    key: other.key,
  });
  expect(shared.status).toBe(200);
  expect(shared.body.url).toBe("https://bot.example.com/one");
});

test("a key without read is refused on its bot's own webhook, and told nothing about another bot's", async () => {
  const holder = createBot(db, "keyholder");
  const mine = (
    await create({ url: "https://bot.example.com/keyholder" }, holder.key)
  ).body.id as string;
  const theirs = (await create({ url: "https://bot.example.com/other" })).body
    .id as string;
  const noRead = createKey(db, holder.actor.id, { actions: ["issues"] }).key;
  const routes = (id: string) =>
    [
      ["GET", `/webhooks/${id}`, undefined],
      ["PATCH", `/webhooks/${id}`, { projects: [a.key] }],
      ["PUT", `/webhooks/${id}/secret`, { secret: NEW_SECRET }],
      ["POST", `/webhooks/${id}/ping`, undefined],
      ["DELETE", `/webhooks/${id}`, undefined],
    ] as const;
  for (const [method, path, json] of routes(mine)) {
    const res = await call(method, path, { json, key: noRead });
    expect(res.status, `${method} own`).toBe(403);
    expect(res.body.error.code).toBe("forbidden_action");
  }
  for (const [method, path, json] of routes(theirs)) {
    const foreign = await call(method, path, { json, key: noRead });
    const missing = await call(method, path.replace(theirs, "no-such"), {
      json,
      key: noRead,
    });
    expect(foreign.status, `${method} foreign`).toBe(404);
    expect(foreign.body).toEqual({
      error: {
        code: "not_found",
        message: missing.body.error.message.replace("no-such", theirs),
      },
    });
  }
  expect(sent).toEqual([]);
  expect(
    (await call("GET", `/webhooks/${mine}`, { key: holder.key })).body,
  ).toMatchObject({ id: mine, projects: [a.key] });
});

test("a key narrower than a webhook can't change, rotate or ping it", async () => {
  const wideBot = createBot(db, "wide-writer");
  const wide = (
    await create(
      { projects: [a.key, b.key], url: "https://bot.example.com/wide-w" },
      wideBot.key,
    )
  ).body.id as string;
  const narrow = createKey(db, wideBot.actor.id, { projects: [a.key] }).key;
  for (const [method, path, json] of [
    ["PATCH", `/webhooks/${wide}`, { projects: [a.key] }],
    ["PUT", `/webhooks/${wide}/secret`, { secret: NEW_SECRET }],
    ["POST", `/webhooks/${wide}/ping`, undefined],
  ] as const) {
    const res = await call(method, path, { json, key: narrow });
    expect(res.status, method).toBe(404);
  }
  expect(sent).toEqual([]);
  expect(
    (await call("GET", `/webhooks/${wide}`, { key: wideBot.key })).body
      .projects,
  ).toEqual([a.key, b.key].sort());
});

test("a scoped key adding a project it can't see on update gets the same 404 as on create", async () => {
  const scoped = createBot(db, "bg-june", {
    scope: { projects: [a.key], actions: ["read"] },
  });
  const id = (await create({ url: "https://bot.example.com/june" }, scoped.key))
    .body.id;
  const hidden = await call("PATCH", `/webhooks/${id}`, {
    json: { projects: [a.key, b.key] },
    key: scoped.key,
  });
  const onCreate = await create(
    { url: "https://bot.example.com/june2", projects: [b.key] },
    scoped.key,
  );
  expect(hidden.status).toBe(404);
  expect(hidden.body).toEqual(onCreate.body);
  expect(
    (await call("GET", `/webhooks/${id}`, { key: scoped.key })).body.projects,
  ).toEqual([a.key]);
});

test("a bot at its webhook limit gets a 409 conflict, not a validation failure", async () => {
  const busy = createBot(db, "busy");
  for (let i = 0; i < 20; i++) {
    const made = await create(
      { url: `https://bot.example.com/busy/${i}` },
      busy.key,
    );
    expect(made.status).toBe(201);
  }
  const over = await create(
    { url: "https://bot.example.com/busy/x" },
    busy.key,
  );
  expect(over.status).toBe(409);
  expect(over.body.error.code).toBe("conflict");
  expect(over.body.error.message).toContain("20 webhooks");
});

test("creates sent at once by a bot one short of its limit make one webhook, not several", async () => {
  const racer = createBot(db, "racer");
  for (let i = 0; i < 19; i++) {
    await create({ url: `https://bot.example.com/racer/${i}` }, racer.key);
  }
  const release = holdDns();
  const racing = [0, 1, 2].map((i) =>
    create({ url: `https://bot.example.com/racer/x${i}` }, racer.key),
  );
  await vi.waitFor(() => expect(lookups).toBe(19 + 3));
  release();
  const statuses = (await Promise.all(racing)).map((r) => r.status).sort();
  expect(statuses).toEqual([201, 409, 409]);
  const listed = await call("GET", "/webhooks", { key: racer.key });
  expect(listed.body.items).toHaveLength(20);
});

test("a webhook deleted while its update waits on DNS is a 404, and nothing is left behind", async () => {
  const id = (await create({ url: "https://bot.example.com/vanishing" })).body
    .id;
  const release = holdDns();
  const updating = call("PATCH", `/webhooks/${id}`, {
    json: { url: "https://bot.example.com/moved", projects: [a.key, b.key] },
  });
  await vi.waitFor(() => expect(lookups).toBe(2));
  expect((await call("DELETE", `/webhooks/${id}`)).status).toBe(200);
  release();
  const updated = await updating;
  expect(updated.status).toBe(404);
  expect(updated.body.error.code).toBe("not_found");
  expect((await call("GET", "/webhooks")).body.items).toEqual([]);
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

test("the spec's 409s say what conflicts on a webhook", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as {
    paths: Record<
      string,
      Record<string, { responses: Record<string, { description: string }> }>
    >;
  };
  const onCreate = spec.paths["/webhooks"]?.post?.responses["409"];
  expect(onCreate?.description).toContain("already has a webhook to that URL");
  expect(onCreate?.description).toContain("20 webhooks");
  expect(
    spec.paths["/webhooks/{id}"]?.patch?.responses["409"]?.description,
  ).toContain("already has a webhook to that URL");
});

test("a signed-in person is refused on every webhook route, owner or member, and changes nothing", async () => {
  const made = await create({ url: "https://bot.example.com/human" });
  const id = made.body.id as string;
  const person = await addMember("pat", [a.id]);
  const admin = await signIn(owner);
  for (const cookie of [person, admin]) {
    for (const [method, path, json] of [
      [
        "POST",
        "/webhooks",
        {
          url: "https://bot.example.com/h2",
          secret: SECRET,
          projects: [a.key],
        },
      ],
      ["GET", "/webhooks", undefined],
      ["GET", `/webhooks/${id}`, undefined],
      ["PATCH", `/webhooks/${id}`, { url: "https://bot.example.com/h3" }],
      ["PUT", `/webhooks/${id}/secret`, { secret: NEW_SECRET }],
      ["POST", `/webhooks/${id}/ping`, undefined],
      ["DELETE", `/webhooks/${id}`, undefined],
    ] as const) {
      const res = await request(method, `/api/v1${path}`, {
        json,
        key: null,
        cookie,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  }
  // the bot's own read shows nothing was made, moved, rotated, pinged or deleted
  expect(sent).toEqual([]);
  const after = await call("GET", "/webhooks");
  expect(after.body.items.map((w: Body) => [w.id, w.url])).toEqual([
    [id, "https://bot.example.com/human"],
  ]);
});

test("limits: 50 projects, a 16 to 256 character secret and a 2048 character URL are the edges", async () => {
  const many = Array.from({ length: 51 }, () => addProject("m").key);
  const atLimit = await create({
    url: "https://bot.example.com/fifty",
    projects: many.slice(0, 50),
  });
  expect(atLimit.status).toBe(201);
  expect(atLimit.body.projects).toHaveLength(50);
  const overLimit = await create({
    url: "https://bot.example.com/fifty-one",
    projects: many,
  });
  expect(overLimit.status).toBe(422);

  const id = atLimit.body.id as string;
  const secretAt = (length: number) => "s".repeat(length);
  for (const length of [16, 256]) {
    const res = await call("PUT", `/webhooks/${id}/secret`, {
      json: { secret: secretAt(length) },
    });
    expect(res.status, `${length} characters`).toBe(200);
  }
  for (const length of [15, 257]) {
    const res = await call("PUT", `/webhooks/${id}/secret`, {
      json: { secret: secretAt(length) },
    });
    expect(res.status, `${length} characters`).toBe(422);
  }
  expect(
    (await create({ url: "https://bot.example.com/s", secret: secretAt(257) }))
      .status,
  ).toBe(422);

  const prefix = "https://bot.example.com/";
  const longest = await create({
    url: prefix + "p".repeat(2048 - prefix.length),
  });
  expect(longest.status).toBe(201);
  const tooLong = await create({
    url: prefix + "p".repeat(2049 - prefix.length),
  });
  expect(tooLong.status).toBe(422);
});

test("rotating the secret ends a pause and clears the failure count", async () => {
  const id = (await create({ url: "https://bot.example.com/rotpause" })).body
    .id;
  db.update(webhookSubscription)
    .set({
      pausedAt: new Date(),
      consecutiveFailures: 8,
      lastError: "HTTP 503",
    })
    .where(eq(webhookSubscription.id, id))
    .run();
  expect((await call("GET", `/webhooks/${id}`)).body).toMatchObject({
    paused: true,
    consecutiveFailures: 8,
  });
  const rotated = await call("PUT", `/webhooks/${id}/secret`, {
    json: { secret: NEW_SECRET },
  });
  expect(rotated.body).toMatchObject({
    paused: false,
    pausedAt: null,
    consecutiveFailures: 0,
  });
});

test("a ping that fails leaves the failure count and the pause alone", async () => {
  const id = (await create({ url: "https://bot.example.com/pingfail" })).body
    .id;
  db.update(webhookSubscription)
    .set({ consecutiveFailures: 5 })
    .where(eq(webhookSubscription.id, id))
    .run();

  answer = 503;
  const refused = await call("POST", `/webhooks/${id}/ping`);
  expect(refused.body).toEqual({
    delivered: false,
    status: 503,
    error: "HTTP 503",
  });
  expect(sent).toHaveLength(1);

  // the name now points inside: refused before any request, and still no count
  resolveTo = ["10.0.0.7"];
  const rebound = await call("POST", `/webhooks/${id}/ping`);
  expect(rebound.body).toMatchObject({ delivered: false, status: null });
  expect(rebound.body.error).toMatch(/internal address/);
  expect(sent).toHaveLength(1);

  // and a ping that gets through does not reset it either
  resolveTo = ["93.184.216.34"];
  answer = 200;
  expect((await call("POST", `/webhooks/${id}/ping`)).body.delivered).toBe(
    true,
  );
  const after = (await call("GET", `/webhooks/${id}`)).body;
  expect(after).toMatchObject({
    consecutiveFailures: 5,
    paused: false,
    lastError: null,
    lastSuccessAt: null,
  });
});
