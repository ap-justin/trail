import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";
import type { Body } from "./test-seed.js";
import { webSeed } from "./test-seed.js";

const { db, request, signIn, owner, addBot, addMember, addProject } =
  setupTestApp();
const { get, item } = webSeed(request);

const ownerCookie = await signIn(owner, { name: "Olive Owner" });
const alpha = addBot("alpha");
const beta = addBot("beta");
const gamma = addBot("gamma");

async function send(
  from: { key: string },
  json: { to?: string; text: string; replyTo?: string; expectsReply?: boolean },
): Promise<Body> {
  const res = await request("POST", "/api/v1/messages", {
    key: from.key,
    json,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as Body).message;
}

const ab1 = await send(alpha, { to: "beta", text: "Is ATL-3 done?" });
const bg1 = await send(beta, {
  to: "gamma",
  text: "Heads up",
  expectsReply: false,
});
const ab2 = await send(beta, { replyTo: ab1.id, text: "Yes, shipped." });

const botRef = (bot: typeof alpha) => ({
  id: bot.actor.id,
  name: bot.actor.displayName,
  kind: "bot",
  title: null,
  photoUrl: null,
});

const inIdOrder = (...bots: (typeof alpha)[]) =>
  bots.sort((x, y) => (x.actor.id < y.actor.id ? -1 : 1)).map(botRef);

test("the owner lists each pair of bots once, newest conversation first, with its last message and count", async () => {
  const { status, body } = await get("/messages", ownerCookie);
  expect(status).toBe(200);
  expect(body.nextCursor).toBeNull();
  expect(body.items).toEqual([
    {
      bots: inIdOrder(alpha, beta),
      count: 2,
      lastAt: ab2.createdAt,
      lastMessage: {
        id: ab2.id,
        senderId: beta.actor.id,
        preview: "Yes, shipped.",
        truncated: false,
        createdAt: ab2.createdAt,
        expectsReply: true,
      },
    },
    {
      bots: inIdOrder(beta, gamma),
      count: 1,
      lastAt: bg1.createdAt,
      lastMessage: {
        id: bg1.id,
        senderId: beta.actor.id,
        preview: "Heads up",
        truncated: false,
        createdAt: bg1.createdAt,
        expectsReply: false,
      },
    },
  ]);
});

const pairPath = `/messages/${alpha.actor.id}/${beta.actor.id}`;
let members = 0;

test.each(["/messages", pairPath])(
  "GET %s is, for an invited member, the same 404 as a route that does not exist",
  async (path) => {
    const member = await addMember(`member-${++members}`, [addProject().id]);
    const res = await get(path, member);
    expect(res).toEqual({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: `no route GET /api/web${path}`,
        },
      },
    });
  },
);

test.each(["/messages", pairPath])(
  "GET %s, signed out, answers as every /api/web route does",
  async (path) => {
    const unknown = await request("GET", "/api/web/no-such-route", {
      key: null,
    });
    const res = await request("GET", `/api/web${path}`, { key: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(await unknown.json());
  },
);

test("the owner reads one pair's messages oldest first, whichever bot is named first, each reply quoting what it answers", async () => {
  const expected = [
    {
      id: ab1.id,
      sender: botRef(alpha),
      recipient: botRef(beta),
      threadId: ab1.id,
      replyTo: null,
      text: "Is ATL-3 done?",
      expectsReply: true,
      createdAt: ab1.createdAt,
      readAt: null,
    },
    {
      id: ab2.id,
      sender: botRef(beta),
      recipient: botRef(alpha),
      threadId: ab1.id,
      replyTo: {
        id: ab1.id,
        senderName: "alpha",
        preview: "Is ATL-3 done?",
        truncated: false,
      },
      text: "Yes, shipped.",
      expectsReply: true,
      createdAt: ab2.createdAt,
      readAt: null,
    },
  ];
  for (const path of [
    pairPath,
    `/messages/${beta.actor.id}/${alpha.actor.id}`,
  ]) {
    expect(await get(path, ownerCookie)).toEqual({
      status: 200,
      body: {
        bots: inIdOrder(alpha, beta),
        items: expected,
        nextCursor: null,
      },
    });
  }
});

test("a pair that has exchanged no messages still names both bots, in id order", async () => {
  for (const path of [
    `/messages/${alpha.actor.id}/${gamma.actor.id}`,
    `/messages/${gamma.actor.id}/${alpha.actor.id}`,
  ]) {
    expect(await get(path, ownerCookie)).toEqual({
      status: 200,
      body: {
        bots: inIdOrder(alpha, gamma),
        items: [],
        nextCursor: null,
      },
    });
  }
});

test("a pair naming an unknown id, a person's id or one bot twice is a 404", async () => {
  const person = db
    .select({ id: actor.id })
    .from(actor)
    .where(eq(actor.displayName, "Olive Owner"))
    .get();
  const a = alpha.actor.id;
  for (const [x, y] of [
    [a, "no-such-id"],
    ["no-such-id", a],
    [a, person?.id],
    [a, a],
  ]) {
    const res = await get(`/messages/${x}/${y}`, ownerCookie);
    expect(res.status, `${x}/${y}`).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  }
});

/** Every page of `path` at one item a page, as the item ids of each. */
async function walk(path: string, idOf: (item: Body) => string) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const query =
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const { status, body } = await get(`${path}?limit=1${query}`, ownerCookie);
    expect(status).toBe(200);
    pages.push(body.items.map(idOf));
    cursor = body.nextCursor;
  } while (cursor !== null);
  return pages;
}

test("both lists page with the cursor each page returns", async () => {
  expect(await walk("/messages", (c) => c.lastMessage.id)).toEqual([
    [ab2.id],
    [bg1.id],
  ]);
  expect(await walk(pairPath, (m) => m.id)).toEqual([[ab1.id], [ab2.id]]);
});

test("a cursor from another pair is a 422", async () => {
  const first = await get(`${pairPath}?limit=1`, ownerCookie);
  const other = await get(
    `/messages/${beta.actor.id}/${gamma.actor.id}?cursor=${encodeURIComponent(first.body.nextCursor)}`,
    ownerCookie,
  );
  expect(other.status).toBe(422);
});

test("the owner reading a pair marks nothing read; the recipient's own mark shows as readAt", async () => {
  const delta = addBot("delta");
  const sent = await send(alpha, { to: "delta", text: "Ping" });
  const path = `/messages/${alpha.actor.id}/${delta.actor.id}`;
  await get(path, ownerCookie);
  await get("/messages", ownerCookie);

  const inbox = await request("GET", "/api/v1/messages", { key: delta.key });
  expect(((await inbox.json()) as Body).items.map((m: Body) => m.id)).toEqual([
    sent.id,
  ]);

  const marked = await request("POST", "/api/v1/messages/read", {
    key: delta.key,
    json: { messageIds: [sent.id] },
  });
  expect(marked.status).toBe(200);
  const { body } = await get(path, ownerCookie);
  expect(body.items[0].readAt).toEqual(expect.any(String));
});

test("a message never shows in the owner's feed or search", async () => {
  const product = addProject("Quokka");
  const itemKey = await item(product.key, "issue", { title: "Quokka item" });
  const sent = await send(beta, { to: "alpha", text: "Quokka zephyr report" });

  const feed = await get("/feed", ownerCookie);
  expect(feed.status).toBe(200);
  expect(feed.body.items.length).toBeGreaterThan(0);
  const shown = JSON.stringify(feed.body);
  for (const text of ["zephyr", sent.id, ab1.id, "shipped"]) {
    expect(shown).not.toContain(text);
  }

  const search = await get("/search?q=quokka", ownerCookie);
  expect(search.status).toBe(200);
  expect(search.body.items.map((i: Body) => i.key)).toEqual([itemKey]);
  expect(JSON.stringify(search.body)).not.toContain("zephyr");
});
