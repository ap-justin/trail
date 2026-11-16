import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count, desc, max } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";
import { newId } from "./id.js";
import { message, messagePair } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0016-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations up to `last`
function through(last: number): string {
  const folder = join(dir, `migrations-${last}`);
  cpSync(fileURLToPath(new URL("./migrations", import.meta.url)), folder, {
    recursive: true,
  });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (e: { idx: number }) => e.idx <= last,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const rows = (db: Db, sql: string, ...params: unknown[]) =>
  db.$client.prepare(sql).all(...params);

const errorCode = (write: () => unknown) => {
  try {
    write();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

const legacyDeliveries = [
  {
    id: "d-delivered",
    subscription_id: "s1",
    event_id: "e1",
    seq: 1,
    type: "trail.product.created",
    status: "delivered",
    body: null,
    attempts: 1,
    next_attempt_at: 0,
    last_status: 200,
    last_error: null,
    created_at: 10,
    delivered_at: 20,
  },
  {
    id: "d-twin",
    subscription_id: "s1",
    event_id: "e1",
    seq: 1,
    type: "trail.project.created",
    status: "failed",
    body: '{"kept":"for debugging"}',
    attempts: 3,
    next_attempt_at: 0,
    last_status: 500,
    last_error: "boom",
    created_at: 11,
    delivered_at: null,
  },
  {
    id: "d-pending",
    subscription_id: "s2",
    event_id: "e2",
    seq: 2,
    type: "trail.product.updated",
    status: "pending",
    body: '{"to":"send"}',
    attempts: 0,
    next_attempt_at: 30,
    last_status: null,
    last_error: null,
    created_at: 12,
    delivered_at: null,
  },
];

let db: Db;

// a database as it stood at 0015: two bots, a product, two subscriptions and their outbox
beforeAll(() => {
  db = openDatabase(join(dir, "messages.db"));
  migrate(db, through(15));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values
      ('alpha', 'bot', 'alpha', 0), ('beta', 'bot', 'beta', 0), ('gamma', 'bot', 'gamma', 0);
    insert into actor (id, kind, display_name, github_id, created_at) values ('h1', 'human', 'Ada', 7, 0);
    insert into product (id, key, name, created_by, created_at, updated_at) values ('p1', 'ATL', 'atlas', 'alpha', 0, 0);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, product_id, action, payload, created_at) values
      ('e1', 1, 'alpha', 'product', 'p1', 'p1', 'product.created', '{}', 5),
      ('e2', 2, 'alpha', 'product', 'p1', 'p1', 'product.updated', '{}', 6);
    insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values
      ('s1', 'alpha', 'https://x.test/a', 'sealed', 1, 1),
      ('s2', 'beta', 'https://x.test/b', 'sealed', 1, 1);
    insert into webhook_subscription_product (subscription_id, product_id) values ('s1', 'p1'), ('s2', 'p1');
  `);
  const insert = db.$client.prepare(
    "insert into webhook_delivery (id, subscription_id, event_id, seq, type, status, body, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at) values (@id, @subscription_id, @event_id, @seq, @type, @status, @body, @attempts, @next_attempt_at, @last_status, @last_error, @created_at, @delivered_at)",
  );
  for (const d of legacyDeliveries) insert.run(d);
  migrate(db, through(16));
  return () => db.$client.close();
});

test("every existing delivery survives the rebuild unchanged, as an event delivery", () => {
  expect(
    rows(
      db,
      "select id, subscription_id, event_id, seq, type, status, body, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at from webhook_delivery order by id",
    ),
  ).toEqual([...legacyDeliveries].sort((a, b) => a.id.localeCompare(b.id)));
  expect(
    rows(
      db,
      "select count(*) n from webhook_delivery where message_id is null",
    ),
  ).toEqual([{ n: 3 }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("existing subscriptions are activity ones; a kind outside the two is refused, and (bot, url) stays unique", () => {
  expect(
    rows(db, "select id, kind from webhook_subscription order by id"),
  ).toEqual([
    { id: "s1", kind: "activity" },
    { id: "s2", kind: "activity" },
  ]);
  const subscribe = (id: string, kind: string, url: string) => () =>
    db.$client
      .prepare(
        "insert into webhook_subscription (id, actor_id, url, kind, secret_cipher, created_at, updated_at) values (?, 'gamma', ?, ?, 'sealed', 1, 1)",
      )
      .run(id, url, kind);
  expect(errorCode(subscribe("s-bad", "messages", "https://x.test/g"))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  expect(errorCode(subscribe("s-inbox", "inbox", "https://x.test/g"))).toBe(
    "no error",
  );
  expect(errorCode(subscribe("s-again", "activity", "https://x.test/g"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
});

// a root message names its own id as its thread; a reply takes the thread of the message it answers
const send = (
  fields: Partial<typeof message.$inferInsert> & {
    senderId: string;
    recipientId: string;
  },
) => {
  const id = fields.id ?? newId();
  return db
    .insert(message)
    .values({ text: "status?", threadId: id, ...fields, id })
    .returning()
    .get();
};

test("a root message is its own thread and expects a reply until told otherwise; seq follows the writes", () => {
  const root = send({ senderId: "alpha", recipientId: "beta" });
  const reply = send({
    senderId: "beta",
    recipientId: "alpha",
    threadId: root.id,
    replyToId: root.id,
    text: "green",
    expectsReply: false,
  });
  expect(root).toMatchObject({
    threadId: root.id,
    replyToId: null,
    expectsReply: true,
    readAt: null,
  });
  expect(reply).toMatchObject({ threadId: root.id, expectsReply: false });
  expect(reply.seq).toBe(root.seq + 1);
});

test.each([
  ["a bot messaging itself", { recipientId: "alpha" }],
  ["empty text", { text: "" }],
  ["a root message in another thread", { threadId: "elsewhere" }],
])("%s is refused", (_, fields) => {
  expect(
    errorCode(() =>
      send({ senderId: "alpha", recipientId: "beta", ...fields }),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("expects_reply is 0 or 1", () => {
  // raw, since drizzle's boolean mode turns any truthy value into 1
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "insert into message (id, seq, sender_id, recipient_id, thread_id, text, expects_reply, created_at) values ('m-two', 999, 'alpha', 'beta', 'm-two', 'hi', 2, 0)",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a reply must answer a message in its own thread, and can't be a thread of its own", () => {
  const first = send({ senderId: "alpha", recipientId: "beta" });
  const other = send({ senderId: "alpha", recipientId: "gamma" });
  const reply = (fields: Partial<typeof message.$inferInsert>) => () =>
    send({
      senderId: "beta",
      recipientId: "alpha",
      replyToId: first.id,
      ...fields,
    });
  expect(errorCode(reply({ threadId: other.id }))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(reply({ replyToId: "missing", threadId: first.id }))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  // threadId defaults to the reply's own id in send()
  expect(errorCode(reply({}))).toBe("SQLITE_CONSTRAINT_CHECK");
  const answer = send({
    senderId: "beta",
    recipientId: "alpha",
    threadId: first.id,
    replyToId: first.id,
  });
  // a reply to a reply stays in the root's thread
  expect(
    errorCode(() =>
      send({
        senderId: "alpha",
        recipientId: "beta",
        threadId: first.id,
        replyToId: answer.id,
      }),
    ),
  ).toBe("no error");
});

test("a message's sender and recipient must exist, and a bot with messages can't be deleted", () => {
  expect(
    errorCode(() => send({ senderId: "alpha", recipientId: "nobody" })),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  expect(
    errorCode(() =>
      db.$client.prepare("delete from actor where id = 'beta'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

const queue =
  (
    id: string,
    subscriptionId: string,
    subject: { eventId?: string; messageId?: string },
    seq = 1,
  ) =>
  () =>
    db.$client
      .prepare(
        "insert into webhook_delivery (id, subscription_id, event_id, message_id, seq, type, next_attempt_at, created_at) values (?, ?, ?, ?, ?, 'trail.message.received', 0, 0)",
      )
      .run(
        id,
        subscriptionId,
        subject.eventId ?? null,
        subject.messageId ?? null,
        seq,
      );

test("a delivery carries an event or a message, never both or neither, and a message once per subscription", () => {
  const sub = "s-inbox-beta";
  db.$client.exec(
    `insert into webhook_subscription (id, actor_id, url, kind, secret_cipher, created_at, updated_at) values ('${sub}', 'beta', 'https://x.test/inbox', 'inbox', 'sealed', 1, 1)`,
  );
  const m = send({ senderId: "alpha", recipientId: "beta" });
  expect(errorCode(queue("q-none", sub, {}))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(
    errorCode(queue("q-both", sub, { eventId: "e1", messageId: m.id })),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(queue("q-1", sub, { messageId: m.id }, m.seq))).toBe(
    "no error",
  );
  expect(errorCode(queue("q-2", sub, { messageId: m.id }, m.seq))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expect(errorCode(queue("q-ghost", sub, { messageId: "missing" }))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  // a message with a delivery can't be deleted
  expect(
    errorCode(() =>
      db.$client.prepare("delete from message where id = ?").run(m.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  // deleting the subscription takes its message deliveries with it
  db.$client.exec(`delete from webhook_subscription where id = '${sub}'`);
  expect(
    rows(
      db,
      "select count(*) n from webhook_delivery where subscription_id = ?",
      sub,
    ),
  ).toEqual([{ n: 0 }]);
  expect(rows(db, "select count(*) n from message where id = ?", m.id)).toEqual(
    [{ n: 1 }],
  );
});

const planOf = (sql: string, ...params: unknown[]) =>
  (rows(db, `explain query plan ${sql}`, ...params) as { detail: string }[])
    .map((r) => r.detail)
    .join(" | ");

test.each([
  [
    "a bot's inbox, newest first, from a cursor",
    "select * from message where recipient_id = ? and seq < ? order by seq desc limit 20",
    ["beta", 100],
    "SEARCH message USING INDEX message_recipient_seq_idx (recipient_id=? AND seq<?)",
  ],
  [
    "its unread inbox",
    "select * from message where recipient_id = ? and read_at is null and seq < ? order by seq desc limit 20",
    ["beta", 100],
    "SEARCH message USING INDEX message_recipient_unread_seq_idx (recipient_id=? AND seq<?)",
  ],
  [
    "its unread count",
    "select count(*) from message where recipient_id = ? and read_at is null",
    ["beta"],
    // not covering: a row read per unread message, to test read_at the index already implies
    "SEARCH message USING INDEX message_recipient_unread_seq_idx (recipient_id=?)",
  ],
  [
    "a thread, oldest first, from a cursor",
    "select * from message where thread_id = ? and seq > ? order by seq limit 50",
    ["t", 0],
    "SEARCH message USING INDEX message_thread_seq_idx (thread_id=? AND seq>?)",
  ],
  [
    "one sender's messages to one recipient in the rate-limit window",
    "select count(*) from message where sender_id = ? and recipient_id = ? and created_at > ?",
    ["alpha", "beta", 0],
    "SEARCH message USING COVERING INDEX message_sender_recipient_created_idx (sender_id=? AND recipient_id=? AND created_at>?)",
  ],
])("%s reads one index range, with no sort", (_, sql, params, step) => {
  const plan = planOf(sql, ...params);
  expect(plan).toBe(step);
});

test("the conversation list groups pairs off the pair index, sorting only the groups", () => {
  // as the api seat builds it: the pair spelled with messagePair, so it matches the index
  const [a, b] = messagePair(message);
  const query = db
    .select({ a, b, count: count(), last: max(message.seq) })
    .from(message)
    .groupBy(a, b)
    .orderBy(desc(max(message.seq)))
    .toSQL();
  const plan = planOf(query.sql, ...query.params);
  expect(plan).toContain(
    "SCAN message USING COVERING INDEX message_pair_seq_idx",
  );
  expect(plan).not.toContain("USE TEMP B-TREE FOR GROUP BY");
});
