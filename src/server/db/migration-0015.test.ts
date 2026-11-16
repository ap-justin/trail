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
import { afterAll, expect, onTestFinished, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";
import { resolveProductOwners } from "./product-owners.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0015-"));
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

let files = 0;
function open(): Db {
  const db = openDatabase(join(dir, `db-${files++}.db`));
  onTestFinished(() => {
    db.$client.close();
  });
  return db;
}

const TARA_AGENT = "agent-3ff34428-5bed-477d-88ab-4bbcd78901e1";

/**
 * A database as it stood at 0014, then migrated through every shipped migration. TRL's owner
 * resolves by label (the bot's name isn't Tara), KRU's by name ignoring case, SKY's bot doesn't
 * exist, and ZZZ isn't in the seed.
 */
function legacyDb(): Db {
  const db = open();
  migrate(db, through(14));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values
      ('tara', 'bot', 'Tara Lane', '${TARA_AGENT}', 0),
      ('kai', 'bot', 'KAI', null, 0),
      ('builder', 'bot', 'builder', 'agt_b', 0);
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at) values
      ('ada', 'human', 'Ada', 7, 'ada', 1, 0);
    insert into project (id, key, name, issue_seq, created_by, created_at, updated_at) values
      ('p-trl', 'TRL', 'trail', 16, 'tara', 1, 1),
      ('p-kru', 'KRU', 'kru', 2, 'kai', 2, 2),
      ('p-sky', 'SKY', 'sky', 2, 'builder', 3, 3),
      ('p-zzz', 'ZZZ', 'zzz', 1, 'builder', 4, 4);
    insert into issue (id, project_id, number, title, status, assignee_id, created_by, created_at, updated_at, completed_at) values
      ('i-trl-12', 'p-trl', 12, 'owner, unassigned', 'open', null, 'tara', 10, 10, null),
      ('i-trl-13', 'p-trl', 13, 'owner, assigned', 'in_progress', 'builder', 'tara', 11, 11, null),
      ('i-trl-14', 'p-trl', 14, 'other bot', 'open', null, 'builder', 12, 12, null),
      ('i-trl-15', 'p-trl', 15, 'person', 'open', null, 'ada', 13, 13, null),
      ('i-trl-16', 'p-trl', 16, 'owner, done', 'done', null, 'tara', 14, 15, 15),
      ('i-kru-1', 'p-kru', 1, 'owner by name', 'open', null, 'kai', 20, 20, null),
      ('i-kru-2', 'p-kru', 2, 'another product''s owner', 'open', null, 'tara', 21, 21, null),
      ('i-sky-1', 'p-sky', 1, 'no owner, its creator', 'open', null, 'builder', 30, 30, null),
      ('i-sky-2', 'p-sky', 2, 'no owner, a seeded bot', 'canceled', null, 'tara', 31, 32, 32),
      ('i-zzz-1', 'p-zzz', 1, 'not in the seed', 'open', null, 'builder', 40, 40, null);
    insert into label (id, project_id, name, created_at) values ('l-bug', 'p-trl', 'bug', 5);
    insert into issue_label (issue_id, label_id, project_id) values ('i-trl-14', 'l-bug', 'p-trl');
    insert into comment (id, issue_id, author_id, body, created_at) values ('c1', 'i-trl-14', 'ada', 'seen it', 50);
    insert into project_status_update (id, project_id, author_id, body, health, created_at) values
      ('su1', 'p-trl', 'tara', 'on course', 'on_track', 60);
    insert into api_key (id, actor_id, prefix, hash, created_at, actions) values
      ('k1', 'builder', 'trl_k1', '${"0".repeat(64)}', 0, '["read","issues"]');
    insert into api_key_project (api_key_id, project_id) values ('k1', 'p-trl'), ('k1', 'p-sky');
    insert into invite (id, username, invited_by, created_at) values (1, 'grace', 'ada', 0);
    insert into project_member (invite_id, project_id, created_at) values (1, 'p-kru', 70);
    insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values
      ('w1', 'builder', 'https://example.com/hook', 'cipher', 0, 0);
    insert into webhook_subscription_project (subscription_id, project_id) values ('w1', 'p-sky');
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, payload, created_at) values
      ('e1', 1, 'tara', 'project', 'p-trl', 'p-trl', 'project.created', '{"name":"trail"}', 1),
      ('e2', 2, 'tara', 'project', 'p-trl', 'p-trl', 'project.updated', '{}', 2),
      ('e3', 3, 'builder', 'issue', 'i-trl-14', 'p-trl', 'issue.created', '{"title":"other bot"}', 12),
      ('e4', 4, 'tara', 'status_update', 'su1', 'p-trl', 'status_update.created', '{}', 60),
      ('e5', 5, 'builder', 'project', 'p-zzz', 'p-zzz', 'project.imported', '{}', 4);
    insert into webhook_delivery (id, subscription_id, event_id, seq, type, status, next_attempt_at, created_at) values
      ('d1', 'w1', 'e1', 1, 'trail.project.created', 'delivered', 0, 1);
    insert into idempotency_key (actor_id, key, scope, request_hash, response, created_at) values
      ('tara', 'k-issue', 'issue.create', 'h', '{"id":"i-trl-12","projectId":"p-trl","number":12,"key":"TRL-12"}', 0),
      ('builder', 'k-issue', 'issue.create', 'h', '{"id":"i-trl-14","projectId":"p-trl","number":14,"key":"TRL-14"}', 0),
      ('tara', 'k-label', 'label.create', 'h', '{"id":"l-bug","projectId":"p-trl","name":"bug"}', 0),
      ('tara', 'k-update', 'status_update.create', 'h', '{"id":"su1","projectId":"p-trl","body":"on course"}', 0),
      ('tara', 'k-product', 'project.create', 'h', '{"id":"p-trl","key":"TRL"}', 0),
      ('ada', 'k-comment', 'comment.create', 'h', '{"id":"c1","issueId":"i-trl-14"}', 0);
  `);
  migrate(db);
  return db;
}

const items = (db: Db) =>
  rows(
    db,
    "select p.key || '-' || i.number as key, i.type, i.status, i.assignee_id from issue i join product p on p.id = i.product_id order by p.created_at, i.number",
  );

test("an item is a todo only when the product's resolved owner created it, and a todo with no assignee gets the owner", () => {
  expect(items(legacyDb())).toEqual([
    { key: "TRL-12", type: "todo", status: "open", assignee_id: "tara" },
    {
      key: "TRL-13",
      type: "todo",
      status: "in_progress",
      assignee_id: "builder",
    },
    { key: "TRL-14", type: "issue", status: "open", assignee_id: null },
    { key: "TRL-15", type: "issue", status: "open", assignee_id: null },
    { key: "TRL-16", type: "todo", status: "done", assignee_id: "tara" },
    { key: "KRU-1", type: "todo", status: "open", assignee_id: "kai" },
    { key: "KRU-2", type: "issue", status: "open", assignee_id: null },
    { key: "SKY-1", type: "issue", status: "open", assignee_id: null },
    { key: "SKY-2", type: "issue", status: "canceled", assignee_id: null },
    { key: "ZZZ-1", type: "issue", status: "open", assignee_id: null },
  ]);
});

test("each product's owner resolves by label, else by name ignoring case, else stays null", () => {
  const db = legacyDb();
  expect(rows(db, "select key, owner_id from product order by key")).toEqual([
    { key: "KRU", owner_id: "kai" },
    { key: "SKY", owner_id: null },
    { key: "TRL", owner_id: "tara" },
    { key: "ZZZ", owner_id: null },
  ]);
  expect(resolveProductOwners(db.$client)).toEqual([
    { product: "KRU", bot: "Kai", resolvedBy: "name", ownerId: "kai" },
    { product: "SKY", bot: "Skye", resolvedBy: "none", ownerId: null },
    { product: "TRL", bot: "Tara", resolvedBy: "label", ownerId: "tara" },
    { product: "ZZZ", bot: null, resolvedBy: "none", ownerId: null },
  ]);
});

// The brief's Migration list, typed out here and not read from product-owners.ts.
const BRIEF_OWNERS = [
  ["TRL", "Tara"],
  ["KRU", "Kai"],
  ["SKY", "Skye"],
  ["DOOP", "Nia"],
  ["LIA", "Quinn"],
  ["ECARDS", "Holly"],
  ["BRAND", "Wren"],
  ["STAND", "Nora"],
  ["NPAPI", "Rhea"],
  ["OFR", "Faye"],
  ["ERRORS", "Remy"],
  ["BGCONN", "Juno"],
  ["BGP", "Ivy"],
  ["DS", "Pia"],
  ["CAD", "Lena"],
  ["BOT", "Vera"],
] as const;

test("every product of the brief's list resolves to its own bot, TRL's by agent id", () => {
  const db = open();
  migrate(db, through(14));
  // each bot is named for its owner, except Tara: her name differs, only her agent label matches
  for (const [key, bot] of BRIEF_OWNERS) {
    const id = `bot-${key.toLowerCase()}`;
    const [name, label] =
      key === "TRL" ? ["Tara Lane", TARA_AGENT] : [bot.toUpperCase(), null];
    db.$client
      .prepare(
        "insert into actor (id, kind, display_name, label, created_at) values (?, 'bot', ?, ?, 0)",
      )
      .run(id, name, label);
    db.$client
      .prepare(
        "insert into project (id, key, name, issue_seq, created_by, created_at, updated_at) values (?, ?, ?, 0, ?, 0, 0)",
      )
      .run(`p-${key.toLowerCase()}`, key, key, id);
  }
  migrate(db);
  expect(rows(db, "select key, owner_id from product order by key")).toEqual(
    BRIEF_OWNERS.map(([key]) => ({
      key,
      owner_id: `bot-${key.toLowerCase()}`,
    })).sort((x, y) => (x.key < y.key ? -1 : 1)),
  );
});

test("a seeded label no bot carries falls back to the bot's name", () => {
  const db = legacyDb();
  expect(
    resolveProductOwners(db.$client, [
      { key: "TRL", bot: "tara lane", agentLabel: "agent-gone" },
    ]).find((r) => r.product === "TRL"),
  ).toEqual({
    product: "TRL",
    bot: "tara lane",
    resolvedBy: "name",
    ownerId: "tara",
  });
});

test("a person never resolves as an owner, whatever their name", () => {
  const db = legacyDb();
  db.$client.exec(
    "insert into actor (id, kind, display_name, created_at) values ('skye', 'human', 'Skye', 0)",
  );
  expect(
    resolveProductOwners(db.$client).find((r) => r.product === "SKY"),
  ).toMatchObject({ resolvedBy: "none", ownerId: null });
});

test("products keep their ids, keys and sequences, and items their ids and numbers", () => {
  const db = legacyDb();
  expect(
    rows(
      db,
      "select id, key, name, issue_seq, created_by, created_at from product order by created_at",
    ),
  ).toEqual([
    {
      id: "p-trl",
      key: "TRL",
      name: "trail",
      issue_seq: 16,
      created_by: "tara",
      created_at: 1,
    },
    {
      id: "p-kru",
      key: "KRU",
      name: "kru",
      issue_seq: 2,
      created_by: "kai",
      created_at: 2,
    },
    {
      id: "p-sky",
      key: "SKY",
      name: "sky",
      issue_seq: 2,
      created_by: "builder",
      created_at: 3,
    },
    {
      id: "p-zzz",
      key: "ZZZ",
      name: "zzz",
      issue_seq: 1,
      created_by: "builder",
      created_at: 4,
    },
  ]);
  expect(
    rows(
      db,
      "select i.id, i.number, i.title, i.created_at, i.updated_at, i.completed_at from issue i join product p on p.id = i.product_id where p.key = 'TRL' order by i.number",
    ),
  ).toEqual([
    {
      id: "i-trl-12",
      number: 12,
      title: "owner, unassigned",
      created_at: 10,
      updated_at: 10,
      completed_at: null,
    },
    {
      id: "i-trl-13",
      number: 13,
      title: "owner, assigned",
      created_at: 11,
      updated_at: 11,
      completed_at: null,
    },
    {
      id: "i-trl-14",
      number: 14,
      title: "other bot",
      created_at: 12,
      updated_at: 12,
      completed_at: null,
    },
    {
      id: "i-trl-15",
      number: 15,
      title: "person",
      created_at: 13,
      updated_at: 13,
      completed_at: null,
    },
    {
      id: "i-trl-16",
      number: 16,
      title: "owner, done",
      created_at: 14,
      updated_at: 15,
      completed_at: 15,
    },
  ]);
  expect(rows(db, "select count(*) as n from issue")).toEqual([{ n: 10 }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("labels, comments and status updates stay on the same rows", () => {
  const db = legacyDb();
  expect(rows(db, "select id, product_id, name from label")).toEqual([
    { id: "l-bug", product_id: "p-trl", name: "bug" },
  ]);
  expect(rows(db, "select * from issue_label")).toEqual([
    { issue_id: "i-trl-14", label_id: "l-bug", product_id: "p-trl" },
  ]);
  expect(rows(db, "select id, issue_id, author_id, body from comment")).toEqual(
    [{ id: "c1", issue_id: "i-trl-14", author_id: "ada", body: "seen it" }],
  );
  expect(
    rows(
      db,
      "select id, product_id, author_id, body, health, created_at from product_status_update",
    ),
  ).toEqual([
    {
      id: "su1",
      product_id: "p-trl",
      author_id: "tara",
      body: "on course",
      health: "on_track",
      created_at: 60,
    },
  ]);
  expect(rows(db, "select * from project_status_update")).toEqual([]);
});

test("key scopes, invites and webhook subscriptions point at the same products", () => {
  const db = legacyDb();
  expect(
    rows(
      db,
      "select api_key_id, product_id from api_key_product order by product_id",
    ),
  ).toEqual([
    { api_key_id: "k1", product_id: "p-sky" },
    { api_key_id: "k1", product_id: "p-trl" },
  ]);
  expect(rows(db, "select actions from api_key where id = 'k1'")).toEqual([
    { actions: '["read","issues"]' },
  ]);
  expect(
    rows(db, "select invite_id, product_id, created_at from product_member"),
  ).toEqual([{ invite_id: 1, product_id: "p-kru", created_at: 70 }]);
  expect(
    rows(
      db,
      "select subscription_id, product_id from webhook_subscription_product",
    ),
  ).toEqual([{ subscription_id: "w1", product_id: "p-sky" }]);
});

test("stored project events become product events; other events and sent deliveries are untouched", () => {
  const db = legacyDb();
  expect(
    rows(
      db,
      "select id, seq, actor_id, subject_type, subject_id, product_id, project_id, action, payload, created_at from activity_event order by seq",
    ),
  ).toEqual([
    {
      id: "e1",
      seq: 1,
      actor_id: "tara",
      subject_type: "product",
      subject_id: "p-trl",
      product_id: "p-trl",
      project_id: null,
      action: "product.created",
      payload: '{"name":"trail"}',
      created_at: 1,
    },
    {
      id: "e2",
      seq: 2,
      actor_id: "tara",
      subject_type: "product",
      subject_id: "p-trl",
      product_id: "p-trl",
      project_id: null,
      action: "product.updated",
      payload: "{}",
      created_at: 2,
    },
    {
      id: "e3",
      seq: 3,
      actor_id: "builder",
      subject_type: "issue",
      subject_id: "i-trl-14",
      product_id: "p-trl",
      project_id: null,
      action: "issue.created",
      payload: '{"title":"other bot"}',
      created_at: 12,
    },
    {
      id: "e4",
      seq: 4,
      actor_id: "tara",
      subject_type: "status_update",
      subject_id: "su1",
      product_id: "p-trl",
      project_id: null,
      action: "status_update.created",
      payload: "{}",
      created_at: 60,
    },
    {
      id: "e5",
      seq: 5,
      actor_id: "builder",
      subject_type: "product",
      subject_id: "p-zzz",
      product_id: "p-zzz",
      project_id: null,
      action: "product.imported",
      payload: "{}",
      created_at: 4,
    },
  ]);
  expect(rows(db, "select id, event_id, type from webhook_delivery")).toEqual([
    { id: "d1", event_id: "e1", type: "trail.project.created" },
  ]);
});

test("a stored create response replays in the row shape this build reads", () => {
  const db = legacyDb();
  const responses = Object.fromEntries(
    rows(
      db,
      "select actor_id || ' ' || key as k, response from idempotency_key",
    ).map((r) => {
      const { k, response } = r as { k: string; response: string };
      return [k, JSON.parse(response)];
    }),
  );
  expect(responses).toEqual({
    "tara k-issue": {
      id: "i-trl-12",
      productId: "p-trl",
      number: 12,
      key: "TRL-12",
      type: "todo",
    },
    "builder k-issue": {
      id: "i-trl-14",
      productId: "p-trl",
      number: 14,
      key: "TRL-14",
      type: "issue",
    },
    "tara k-label": { id: "l-bug", productId: "p-trl", name: "bug" },
    "tara k-update": { id: "su1", productId: "p-trl", body: "on course" },
    "tara k-product": { id: "p-trl", key: "TRL" },
    "ada k-comment": { id: "c1", issueId: "i-trl-14" },
  });
});

test("the migration creates no projects", () => {
  const db = legacyDb();
  for (const table of [
    "project",
    "project_product",
    "project_item",
    "project_status_update",
  ]) {
    expect(rows(db, `select count(*) as n from ${table}`)).toEqual([{ n: 0 }]);
  }
});

const errorCode = (write: () => unknown) => {
  try {
    write();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

test("a todo is never in triage; an issue may be", () => {
  const db = legacyDb();
  const setStatus = (id: string) => () =>
    db.$client
      .prepare("update issue set status = 'triage' where id = ?")
      .run(id);
  expect(errorCode(setStatus("i-trl-12"))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(setStatus("i-trl-14"))).toBe("no error");
  expect(
    errorCode(() =>
      db.$client
        .prepare("update issue set type = 'todo' where id = 'i-trl-14'")
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("an item joins a project only through one of the project's products", () => {
  const db = legacyDb();
  db.$client.exec(`
    insert into project (id, slug, name, lead_id, created_by, created_at, updated_at) values
      ('pj', 'launch-q4', 'Launch', 'tara', 'tara', 0, 0);
    insert into project_product (project_id, product_id) values ('pj', 'p-trl');
  `);
  const add = (issueId: string, productId: string) => () =>
    db.$client
      .prepare(
        "insert into project_item (project_id, issue_id, product_id, added_by, created_at) values ('pj', ?, ?, 'tara', 0)",
      )
      .run(issueId, productId);
  // KRU is not one of the project's products
  expect(errorCode(add("i-kru-1", "p-kru"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  // the item's product must be the one it names
  expect(errorCode(add("i-kru-1", "p-trl"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(add("i-trl-12", "p-trl"))).toBe("no error");
  expect(errorCode(add("i-trl-12", "p-trl"))).toBe(
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );
});

test("a label still goes only on an item of its own product", () => {
  const db = legacyDb();
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "insert into issue_label (issue_id, label_id, product_id) values ('i-kru-1', 'l-bug', 'p-kru')",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("a fresh database migrates to the product tables, with no projects", () => {
  const db = open();
  migrate(db);
  const tables = rows(
    db,
    "select name from sqlite_master where type = 'table' and name in ('product', 'project', 'project_product', 'project_item', 'project_status_update', 'product_status_update', 'api_key_product', 'product_member', 'webhook_subscription_product', 'api_key_project', 'project_member', 'webhook_subscription_project') order by name",
  ).map((r) => (r as { name: string }).name);
  expect(tables).toEqual([
    "api_key_product",
    "product",
    "product_member",
    "product_status_update",
    "project",
    "project_item",
    "project_product",
    "project_status_update",
    "webhook_subscription_product",
  ]);
  expect(rows(db, "select * from project")).toEqual([]);
});
