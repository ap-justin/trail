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

/**
 * A database as it stood at 0014, then migrated through every shipped migration. Bots alpha and
 * beta created ATL and BTL, a person created CTL, and bot gamma created no product.
 */
function legacyDb(): Db {
  const db = open();
  migrate(db, through(14));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values
      ('alpha', 'bot', 'alpha', 'agent-alpha', 0),
      ('beta', 'bot', 'beta', null, 0),
      ('gamma', 'bot', 'gamma', 'agent-gamma', 0);
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at) values
      ('ada', 'human', 'Ada', 7, 'ada', 1, 0);
    insert into project (id, key, name, issue_seq, created_by, created_at, updated_at) values
      ('p-atl', 'ATL', 'atlas', 16, 'alpha', 1, 1),
      ('p-btl', 'BTL', 'beacon', 2, 'beta', 2, 2),
      ('p-ctl', 'CTL', 'cobalt', 2, 'ada', 3, 3);
    insert into issue (id, project_id, number, title, status, assignee_id, created_by, created_at, updated_at, completed_at) values
      ('i-atl-12', 'p-atl', 12, 'owner, unassigned', 'open', null, 'alpha', 10, 10, null),
      ('i-atl-13', 'p-atl', 13, 'owner, assigned', 'in_progress', 'gamma', 'alpha', 11, 11, null),
      ('i-atl-14', 'p-atl', 14, 'other bot', 'open', null, 'gamma', 12, 12, null),
      ('i-atl-15', 'p-atl', 15, 'person', 'open', null, 'ada', 13, 13, null),
      ('i-atl-16', 'p-atl', 16, 'owner, done', 'done', null, 'alpha', 14, 15, 15),
      ('i-btl-1', 'p-btl', 1, 'owner', 'open', null, 'beta', 20, 20, null),
      ('i-btl-2', 'p-btl', 2, 'another product''s owner', 'open', null, 'alpha', 21, 21, null),
      ('i-ctl-1', 'p-ctl', 1, 'no owner, a bot', 'open', null, 'gamma', 30, 30, null),
      ('i-ctl-2', 'p-ctl', 2, 'no owner, its creator', 'canceled', null, 'ada', 31, 32, 32);
    insert into label (id, project_id, name, created_at) values ('l-bug', 'p-atl', 'bug', 5);
    insert into issue_label (issue_id, label_id, project_id) values ('i-atl-14', 'l-bug', 'p-atl');
    insert into comment (id, issue_id, author_id, body, created_at) values ('c1', 'i-atl-14', 'ada', 'seen it', 50);
    insert into project_status_update (id, project_id, author_id, body, health, created_at) values
      ('su1', 'p-atl', 'alpha', 'on course', 'on_track', 60);
    insert into api_key (id, actor_id, prefix, hash, created_at, actions) values
      ('k1', 'gamma', 'trl_k1', '${"0".repeat(64)}', 0, '["read","issues"]');
    insert into api_key_project (api_key_id, project_id) values ('k1', 'p-atl'), ('k1', 'p-ctl');
    insert into invite (id, username, invited_by, created_at) values (1, 'grace', 'ada', 0);
    insert into project_member (invite_id, project_id, created_at) values (1, 'p-btl', 70);
    insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values
      ('w1', 'gamma', 'https://example.com/hook', 'cipher', 0, 0);
    insert into webhook_subscription_project (subscription_id, project_id) values ('w1', 'p-ctl');
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, payload, created_at) values
      ('e1', 1, 'alpha', 'project', 'p-atl', 'p-atl', 'project.created', '{"name":"atlas"}', 1),
      ('e2', 2, 'alpha', 'project', 'p-atl', 'p-atl', 'project.updated', '{}', 2),
      ('e3', 3, 'gamma', 'issue', 'i-atl-14', 'p-atl', 'issue.created', '{"title":"other bot"}', 12),
      ('e4', 4, 'alpha', 'status_update', 'su1', 'p-atl', 'status_update.created', '{}', 60),
      ('e5', 5, 'ada', 'project', 'p-ctl', 'p-ctl', 'project.imported', '{}', 3);
    insert into webhook_delivery (id, subscription_id, event_id, seq, type, status, next_attempt_at, created_at) values
      ('d1', 'w1', 'e1', 1, 'trail.project.created', 'delivered', 0, 1);
    insert into idempotency_key (actor_id, key, scope, request_hash, response, created_at) values
      ('alpha', 'k-issue', 'issue.create', 'h', '{"id":"i-atl-12","projectId":"p-atl","number":12,"key":"ATL-12"}', 0),
      ('gamma', 'k-issue', 'issue.create', 'h', '{"id":"i-atl-14","projectId":"p-atl","number":14,"key":"ATL-14"}', 0),
      ('alpha', 'k-label', 'label.create', 'h', '{"id":"l-bug","projectId":"p-atl","name":"bug"}', 0),
      ('alpha', 'k-update', 'status_update.create', 'h', '{"id":"su1","projectId":"p-atl","body":"on course"}', 0),
      ('alpha', 'k-product', 'project.create', 'h', '{"id":"p-atl","key":"ATL"}', 0),
      ('ada', 'k-comment', 'comment.create', 'h', '{"id":"c1","issueId":"i-atl-14"}', 0);
  `);
  migrate(db);
  return db;
}

const items = (db: Db) =>
  rows(
    db,
    "select p.key || '-' || i.number as key, i.type, i.status, i.assignee_id from issue i join product p on p.id = i.product_id order by p.created_at, i.number",
  );

test("each product's owner is the bot that created it; a product a person created has none", () => {
  expect(
    rows(legacyDb(), "select key, owner_id from product order by key"),
  ).toEqual([
    { key: "ATL", owner_id: "alpha" },
    { key: "BTL", owner_id: "beta" },
    { key: "CTL", owner_id: null },
  ]);
});

test("an item is a todo only when its product's owner filed it, and a todo with no assignee gets the owner", () => {
  expect(items(legacyDb())).toEqual([
    { key: "ATL-12", type: "todo", status: "open", assignee_id: "alpha" },
    {
      key: "ATL-13",
      type: "todo",
      status: "in_progress",
      assignee_id: "gamma",
    },
    // filed by a bot that is not ATL's owner, then by a person
    { key: "ATL-14", type: "issue", status: "open", assignee_id: null },
    { key: "ATL-15", type: "issue", status: "open", assignee_id: null },
    { key: "ATL-16", type: "todo", status: "done", assignee_id: "alpha" },
    { key: "BTL-1", type: "todo", status: "open", assignee_id: "beta" },
    // alpha owns ATL, not BTL
    { key: "BTL-2", type: "issue", status: "open", assignee_id: null },
    // CTL has no owner, so every item is an issue
    { key: "CTL-1", type: "issue", status: "open", assignee_id: null },
    { key: "CTL-2", type: "issue", status: "canceled", assignee_id: null },
  ]);
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
      id: "p-atl",
      key: "ATL",
      name: "atlas",
      issue_seq: 16,
      created_by: "alpha",
      created_at: 1,
    },
    {
      id: "p-btl",
      key: "BTL",
      name: "beacon",
      issue_seq: 2,
      created_by: "beta",
      created_at: 2,
    },
    {
      id: "p-ctl",
      key: "CTL",
      name: "cobalt",
      issue_seq: 2,
      created_by: "ada",
      created_at: 3,
    },
  ]);
  expect(
    rows(
      db,
      "select i.id, i.number, i.title, i.created_at, i.updated_at, i.completed_at from issue i join product p on p.id = i.product_id where p.key = 'ATL' order by i.number",
    ),
  ).toEqual([
    {
      id: "i-atl-12",
      number: 12,
      title: "owner, unassigned",
      created_at: 10,
      updated_at: 10,
      completed_at: null,
    },
    {
      id: "i-atl-13",
      number: 13,
      title: "owner, assigned",
      created_at: 11,
      updated_at: 11,
      completed_at: null,
    },
    {
      id: "i-atl-14",
      number: 14,
      title: "other bot",
      created_at: 12,
      updated_at: 12,
      completed_at: null,
    },
    {
      id: "i-atl-15",
      number: 15,
      title: "person",
      created_at: 13,
      updated_at: 13,
      completed_at: null,
    },
    {
      id: "i-atl-16",
      number: 16,
      title: "owner, done",
      created_at: 14,
      updated_at: 15,
      completed_at: 15,
    },
  ]);
  expect(rows(db, "select count(*) as n from issue")).toEqual([{ n: 9 }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("labels, comments and status updates stay on the same rows", () => {
  const db = legacyDb();
  expect(rows(db, "select id, product_id, name from label")).toEqual([
    { id: "l-bug", product_id: "p-atl", name: "bug" },
  ]);
  expect(rows(db, "select * from issue_label")).toEqual([
    { issue_id: "i-atl-14", label_id: "l-bug", product_id: "p-atl" },
  ]);
  expect(rows(db, "select id, issue_id, author_id, body from comment")).toEqual(
    [{ id: "c1", issue_id: "i-atl-14", author_id: "ada", body: "seen it" }],
  );
  expect(
    rows(
      db,
      "select id, product_id, author_id, body, health, created_at from product_status_update",
    ),
  ).toEqual([
    {
      id: "su1",
      product_id: "p-atl",
      author_id: "alpha",
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
    { api_key_id: "k1", product_id: "p-atl" },
    { api_key_id: "k1", product_id: "p-ctl" },
  ]);
  expect(rows(db, "select actions from api_key where id = 'k1'")).toEqual([
    { actions: '["read","issues"]' },
  ]);
  expect(
    rows(db, "select invite_id, product_id, created_at from product_member"),
  ).toEqual([{ invite_id: 1, product_id: "p-btl", created_at: 70 }]);
  expect(
    rows(
      db,
      "select subscription_id, product_id from webhook_subscription_product",
    ),
  ).toEqual([{ subscription_id: "w1", product_id: "p-ctl" }]);
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
      actor_id: "alpha",
      subject_type: "product",
      subject_id: "p-atl",
      product_id: "p-atl",
      project_id: null,
      action: "product.created",
      payload: '{"name":"atlas"}',
      created_at: 1,
    },
    {
      id: "e2",
      seq: 2,
      actor_id: "alpha",
      subject_type: "product",
      subject_id: "p-atl",
      product_id: "p-atl",
      project_id: null,
      action: "product.updated",
      payload: "{}",
      created_at: 2,
    },
    {
      id: "e3",
      seq: 3,
      actor_id: "gamma",
      subject_type: "issue",
      subject_id: "i-atl-14",
      product_id: "p-atl",
      project_id: null,
      action: "issue.created",
      payload: '{"title":"other bot"}',
      created_at: 12,
    },
    {
      id: "e4",
      seq: 4,
      actor_id: "alpha",
      subject_type: "status_update",
      subject_id: "su1",
      product_id: "p-atl",
      project_id: null,
      action: "status_update.created",
      payload: "{}",
      created_at: 60,
    },
    {
      id: "e5",
      seq: 5,
      actor_id: "ada",
      subject_type: "product",
      subject_id: "p-ctl",
      product_id: "p-ctl",
      project_id: null,
      action: "product.imported",
      payload: "{}",
      created_at: 3,
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
    "alpha k-issue": {
      id: "i-atl-12",
      productId: "p-atl",
      number: 12,
      key: "ATL-12",
      type: "todo",
    },
    "gamma k-issue": {
      id: "i-atl-14",
      productId: "p-atl",
      number: 14,
      key: "ATL-14",
      type: "issue",
    },
    "alpha k-label": { id: "l-bug", productId: "p-atl", name: "bug" },
    "alpha k-update": { id: "su1", productId: "p-atl", body: "on course" },
    "alpha k-product": { id: "p-atl", key: "ATL" },
    "ada k-comment": { id: "c1", issueId: "i-atl-14" },
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
  expect(errorCode(setStatus("i-atl-12"))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(setStatus("i-atl-14"))).toBe("no error");
  expect(
    errorCode(() =>
      db.$client
        .prepare("update issue set type = 'todo' where id = 'i-atl-14'")
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("an item joins a project only through one of the project's products", () => {
  const db = legacyDb();
  db.$client.exec(`
    insert into project (id, slug, name, lead_id, created_by, created_at, updated_at) values
      ('pj', 'launch-q4', 'Launch', 'alpha', 'alpha', 0, 0);
    insert into project_product (project_id, product_id) values ('pj', 'p-atl');
  `);
  const add = (issueId: string, productId: string) => () =>
    db.$client
      .prepare(
        "insert into project_item (project_id, issue_id, product_id, added_by, created_at) values ('pj', ?, ?, 'alpha', 0)",
      )
      .run(issueId, productId);
  // BTL is not one of the project's products
  expect(errorCode(add("i-btl-1", "p-btl"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  // the item's product must be the one it names
  expect(errorCode(add("i-btl-1", "p-atl"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(add("i-atl-12", "p-atl"))).toBe("no error");
  expect(errorCode(add("i-atl-12", "p-atl"))).toBe(
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );
});

test("a label still goes only on an item of its own product", () => {
  const db = legacyDb();
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "insert into issue_label (issue_id, label_id, product_id) values ('i-btl-1', 'l-bug', 'p-btl')",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("a sent delivery stays, and its event can queue once more under each other type", () => {
  const db = legacyDb();
  const insert = db.$client.prepare(
    "insert into webhook_delivery (id, subscription_id, event_id, seq, type, next_attempt_at, created_at) values (?, 'w1', 'e1', 1, ?, 0, 0)",
  );
  expect(errorCode(() => insert.run("d2", "trail.product.created"))).toBe(
    "no error",
  );
  expect(errorCode(() => insert.run("d3", "trail.product.created"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expect(errorCode(() => insert.run("d4", "trail.project.created"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
});

test("before the migration an event queued once per webhook, whatever its type", () => {
  const db = open();
  migrate(db, through(14));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values ('b1', 'bot', 'gamma', 'agent-gamma', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values ('p1', 'ATL', 'atlas', 'b1', 0, 0);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, payload, created_at)
      values ('e1', 1, 'b1', 'project', 'p1', 'p1', 'project.updated', '{}', 0);
    insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at)
      values ('s1', 'b1', 'https://bot.example.com/hook', 'x', 0, 0);
    insert into webhook_delivery (id, subscription_id, event_id, seq, type, next_attempt_at, created_at)
      values ('d1', 's1', 'e1', 1, 'trail.project.updated', 0, 0);
  `);
  const insertProductType = () =>
    db.$client
      .prepare(
        "insert into webhook_delivery (id, subscription_id, event_id, seq, type, next_attempt_at, created_at) values ('d2', 's1', 'e1', 1, 'trail.product.updated', 0, 0)",
      )
      .run();
  expect(errorCode(insertProductType)).toBe("SQLITE_CONSTRAINT_UNIQUE");
  migrate(db);
  expect(errorCode(insertProductType)).toBe("no error");
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
