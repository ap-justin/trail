import { asc, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { actor, issue, issueEndMail, product } from "../db/schema.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, bot, request, inviteEmail, signInWithEmail } = setupTestApp();

// bot creates the product, so it is the owner; `handled` files for its handler
const PERSON = "hana.handler@example.com";
inviteEmail(PERSON);
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

await api("POST", "/products", bot.key, { key: "OBX", name: "outbox" });

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
  const number = Number(key.split("-")[1]);
  return db
    .select({
      status: issueEndMail.status,
      recipientId: issueEndMail.recipientId,
      commentId: issueEndMail.commentId,
      state: issueEndMail.state,
    })
    .from(issueEndMail)
    .innerJoin(issue, eq(issue.id, issueEndMail.issueId))
    .where(eq(issue.number, number))
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
