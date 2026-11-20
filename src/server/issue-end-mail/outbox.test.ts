import { and, asc, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  actor,
  issue,
  issueEndMail,
  product,
  productMember,
} from "../db/schema.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, bot, request, inviteEmail, signInWithEmail, signIn, owner } =
  setupTestApp();

// bot creates the product, so it is the owner; `handled` files for its handler
const PERSON = "hana.handler@example.com";
const personInvite = inviteEmail(PERSON);
await signInWithEmail(PERSON);
const person = db.select().from(actor).where(eq(actor.email, PERSON)).get();
if (!person) throw new Error("no person");
const handled = createBot(db, "outbox handled");
setBotHandler(db, handled.actor.id, PERSON);
const helper = createBot(db, "outbox helper");

async function api(method: string, path: string, key: string, json?: object) {
  const res = await request(method, `/api/v1${path}`, { key, json });
  const body = await res.json();
  expect(res.status, `${method} ${path}: ${JSON.stringify(body)}`).toBeLessThan(
    300,
  );
  // biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
  return body as any;
}

const obx = await api("POST", "/products", bot.key, {
  key: "OBX",
  name: "outbox",
});
const letSee = (inviteId: number, productId: string) =>
  db.insert(productMember).values({ inviteId, productId }).run();
letSee(personInvite, obx.id);

async function fileForPerson(title = "for hana"): Promise<string> {
  const filed = await api("POST", "/items", handled.key, {
    type: "issue",
    product: "OBX",
    title,
    filed_for: "handler",
  });
  return filed.key;
}

const setStatus = (key: string, status: string, as = bot.key) =>
  api("PATCH", `/items/${key}`, as, { status });

const comment = (key: string, body: string, as = bot.key) =>
  api("POST", `/items/${key}/comments`, as, { body });

function rowsFor(key: string) {
  const [productKey, n] = key.split("-");
  const number = Number(n);
  return db
    .select({
      status: issueEndMail.status,
      recipientId: issueEndMail.recipientId,
      commentId: issueEndMail.commentId,
      state: issueEndMail.state,
    })
    .from(issueEndMail)
    .innerJoin(issue, eq(issue.id, issueEndMail.issueId))
    .innerJoin(product, eq(product.id, issue.productId))
    .where(and(eq(issue.number, number), eq(product.key, productKey ?? "")))
    .orderBy(asc(issueEndMail.createdAt), asc(issueEndMail.id))
    .all();
}

test("done writes one pending email for the person it was filed for", async () => {
  const key = await fileForPerson();
  await setStatus(key, "done");
  expect(rowsFor(key)).toEqual([
    {
      status: "done",
      recipientId: person.id,
      commentId: null,
      state: "pending",
    },
  ]);
});

test("who an issue is filed for is fixed at filing: a later handler change or clearing still mails the original person", async () => {
  const SUCCESSOR = "sam.successor@example.com";
  const successorInvite = inviteEmail(SUCCESSOR);
  await signInWithEmail(SUCCESSOR);
  letSee(successorInvite, obx.id);
  const successor = db
    .select()
    .from(actor)
    .where(eq(actor.email, SUCCESSOR))
    .get();
  const mine = createBot(db, "outbox reassigned");
  setBotHandler(db, mine.actor.id, PERSON);
  const file = async (title: string) =>
    (
      await api("POST", "/items", mine.key, {
        type: "issue",
        product: "OBX",
        title,
        filed_for: "handler",
      })
    ).key as string;

  const reassigned = await file("before a change");
  const cleared = await file("before a clearing");
  setBotHandler(db, mine.actor.id, SUCCESSOR);
  await setStatus(reassigned, "done");
  setBotHandler(db, mine.actor.id, null);
  await setStatus(cleared, "done");

  expect(rowsFor(reassigned).map((r) => r.recipientId)).toEqual([person.id]);
  expect(rowsFor(cleared).map((r) => r.recipientId)).toEqual([person.id]);
  expect(successor?.id).not.toBe(person.id);
});

test("canceled writes one email too", async () => {
  const key = await fileForPerson();
  await setStatus(key, "canceled");
  expect(rowsFor(key).map((r) => r.status)).toEqual(["canceled"]);
});

test("reopened and ended again is a second email; done to canceled is not a new ending", async () => {
  const key = await fileForPerson();
  await setStatus(key, "done");
  await setStatus(key, "canceled");
  expect(rowsFor(key).map((r) => r.status)).toEqual(["done"]);
  await setStatus(key, "open");
  await setStatus(key, "done");
  expect(rowsFor(key).map((r) => r.status)).toEqual(["done", "done"]);
});

test("accepting, other status changes and comments write no email", async () => {
  const key = await fileForPerson();
  await setStatus(key, "open");
  await setStatus(key, "in_progress");
  await comment(key, "on it");
  await api("PATCH", `/items/${key}`, bot.key, { priority: 2 });
  expect(rowsFor(key)).toEqual([]);
});

test("an issue a bot filed as its own writes no email when it ends", async () => {
  const own = await api("POST", "/items", handled.key, {
    type: "issue",
    product: "OBX",
    title: "my own",
  });
  await setStatus(own.key, "done");
  expect(rowsFor(own.key)).toEqual([]);
});

test("an issue a person filed on the web emails that person when a bot ends it", async () => {
  const WEB = "wes.web@example.com";
  const obx = db.select().from(product).where(eq(product.key, "OBX")).get();
  inviteEmail(WEB, [obx?.id ?? ""]);
  const cookie = await signInWithEmail(WEB);
  const res = await request("POST", "/api/web/issues", {
    key: null,
    cookie,
    json: { product: "OBX", title: "from the web" },
  });
  expect(res.status).toBe(201);
  const { key } = (await res.json()) as { key: string };
  await setStatus(key, "done");
  const filer = db.select().from(actor).where(eq(actor.email, WEB)).get();
  expect(rowsFor(key).map((r) => r.recipientId)).toEqual([filer?.id]);
});

test("the email keeps the owner bot's newest comment as the issue ended: not another bot's, not a later one", async () => {
  const key = await fileForPerson();
  await comment(key, "first look");
  const reason = await comment(key, "fixed: the export flushes now");
  await comment(key, "a helper's note", helper.key);
  await setStatus(key, "done");
  await comment(key, "one more thing");
  expect(rowsFor(key).map((r) => r.commentId)).toEqual([reason.id]);
});

test("a person who unsubscribed gets no new email", async () => {
  db.update(actor)
    .set({ issueEndMailOff: true })
    .where(eq(actor.id, person.id))
    .run();
  try {
    const key = await fileForPerson();
    await setStatus(key, "done");
    expect(rowsFor(key)).toEqual([]);
  } finally {
    db.update(actor)
      .set({ issueEndMailOff: false })
      .where(eq(actor.id, person.id))
      .run();
  }
});

test("a product with no owner still queues the email, with no comment, and does not throw", async () => {
  const noo = await api("POST", "/products", bot.key, {
    key: "NOO",
    name: "no owner",
  });
  letSee(personInvite, noo.id);
  db.update(product).set({ ownerId: null }).where(eq(product.key, "NOO")).run();
  const filed = await api("POST", "/items", handled.key, {
    type: "issue",
    product: "NOO",
    title: "nobody owns this",
    filed_for: "handler",
  });
  // the bot that made the product commented, as an owner's comment would be kept
  await comment(filed.key, "closing this out");
  await setStatus(filed.key, "done", helper.key);
  expect(rowsFor(filed.key)).toEqual([
    {
      status: "done",
      recipientId: person.id,
      commentId: null,
      state: "pending",
    },
  ]);
});

test("an issue filed for a person and accepted as a todo still emails them when it ends", async () => {
  const key = await fileForPerson("accepted as a todo");
  await api("PATCH", `/items/${key}`, bot.key, { type: "todo" });
  await setStatus(key, "done");
  expect(rowsFor(key).map((r) => [r.status, r.recipientId])).toEqual([
    ["done", person.id],
  ]);
});

test("a handler whose invite doesn't list the issue's product gets no email", async () => {
  const BLIND = "bo.blind@example.com";
  inviteEmail(BLIND);
  await signInWithEmail(BLIND);
  const blindBot = createBot(db, "outbox blind");
  setBotHandler(db, blindBot.actor.id, BLIND);
  const filed = await api("POST", "/items", blindBot.key, {
    type: "issue",
    product: "OBX",
    title: "for bo, who can't see OBX",
    filed_for: "handler",
  });
  await setStatus(filed.key, "done");
  expect(rowsFor(filed.key)).toEqual([]);
});

test("the owner, listed under no invite, sees every product and gets the email", async () => {
  const res = await request("POST", "/api/web/issues", {
    key: null,
    cookie: await signIn(owner),
    json: { product: "OBX", title: "the owner's own" },
  });
  expect(res.status).toBe(201);
  const { key } = (await res.json()) as { key: string };
  await setStatus(key, "done");
  const ownerActor = db
    .select()
    .from(actor)
    .where(eq(actor.isOwner, true))
    .get();
  expect(rowsFor(key).map((r) => r.recipientId)).toEqual([ownerActor?.id]);
});

test("the filing bot cancelling its own issue keeps its own newest comment, not the owner's", async () => {
  const key = await fileForPerson("withdrawn by the filer");
  await comment(key, "accepted, on it");
  const reason = await comment(
    key,
    "withdrawn: the export was never broken",
    handled.key,
  );
  await setStatus(key, "canceled", handled.key);
  expect(rowsFor(key).map((r) => r.commentId)).toEqual([reason.id]);
});

test("an ending by a bot that wrote no comment keeps the owner's newest", async () => {
  const key = await fileForPerson("withdrawn without a word");
  const owners = await comment(key, "accepted, on it");
  await setStatus(key, "canceled", handled.key);
  expect(rowsFor(key).map((r) => r.commentId)).toEqual([owners.id]);
});
