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
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";

const shipped = fileURLToPath(new URL("./migrations", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "trail-0023-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations up to `last`
function through(last: number): string {
  const folder = join(dir, `migrations-${last}`);
  cpSync(shipped, folder, { recursive: true });
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

const run = (sql: string) => () => db.$client.prepare(sql).run();

const insert = (table: string, row: Record<string, unknown>) => () => {
  const columns = Object.keys(row);
  db.$client
    .prepare(
      `insert into ${table} (${columns.join(", ")}) values (${columns.map((k) => `@${k}`).join(", ")})`,
    )
    .run(row);
};

let db: Db;
const before: Record<string, unknown[]> = {};

// a database as it stood at 0022: a person and a bot, an issue the bot filed that ended with
// a comment, so a change to actor or issue that touched existing rows, or rebuilt a table
// the comment and event hang from, shows
beforeAll(() => {
  db = openDatabase(join(dir, "filed-for.db"));
  migrate(db, through(22));
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at)
      values ('hana', 'human', 'Hana', 101, 'hana-example', 1, 0);
    insert into actor (id, kind, display_name, label, title, created_at)
      values ('alpha', 'bot', 'alpha', 'agent-alpha', 'Builder', 1);
    insert into product (id, key, name, created_by, created_at, updated_at) values ('p1', 'ATL', 'atlas', 'alpha', 0, 0);
    insert into issue (id, product_id, number, type, title, status, assignee_id, created_by, created_at, updated_at, completed_at)
      values ('i1', 'p1', 1, 'issue', 'an issue', 'done', 'alpha', 'alpha', 1, 2, 2);
    insert into comment (id, issue_id, author_id, body, created_at) values ('c1', 'i1', 'alpha', 'fixed', 2);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, product_id, action, payload, created_at)
      values ('e1', 1, 'alpha', 'issue', 'i1', 'p1', 'issue.status_changed', '{"to":"done"}', 2);
  `);
  for (const table of ["actor", "issue", "comment", "activity_event"]) {
    before[table] = rows(db, `select * from ${table} order by id`);
  }
  migrate(db, through(23));
  return () => db.$client.close();
});

afterEach(() => {
  db.$client.exec(`
    delete from issue_end_mail;
    delete from issue where id <> 'i1';
    delete from actor where id not in ('hana', 'alpha');
    update actor set handler_id = null, issue_end_mail_off = 0;
  `);
});

const withNew = (table: string, added: Record<string, unknown>) =>
  (before[table] as Record<string, unknown>[]).map((r) => ({ ...r, ...added }));

test("existing actors are kept as they were, with no handler and mail on", () => {
  expect(rows(db, "select * from actor order by id")).toEqual(
    withNew("actor", { handler_id: null, issue_end_mail_off: 0 }),
  );
});

test("existing issues are kept as they were, filed for nobody", () => {
  expect(rows(db, "select * from issue order by id")).toEqual(
    withNew("issue", { filed_for_id: null }),
  );
});

test("the rows hanging from actor and issue survive, and every table stays strict", () => {
  expect(rows(db, "select * from comment order by id")).toEqual(before.comment);
  expect(rows(db, "select * from activity_event order by id")).toEqual(
    before.activity_event,
  );
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  expect(
    rows(
      db,
      "select name, strict from pragma_table_list where name in ('actor', 'issue', 'issue_end_mail') order by name",
    ),
  ).toEqual([
    { name: "actor", strict: 1 },
    { name: "issue", strict: 1 },
    { name: "issue_end_mail", strict: 1 },
  ]);
});

test("a bot can name the person it works for", () => {
  expect(
    errorCode(run("update actor set handler_id = 'hana' where id = 'alpha'")),
  ).toBe("no error");
});

test("a person can't have a handler", () => {
  expect(
    errorCode(run("update actor set handler_id = 'alpha' where id = 'hana'")),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a handler must be an actor", () => {
  expect(
    errorCode(run("update actor set handler_id = 'nobody' where id = 'alpha'")),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("a person can turn the ending email off", () => {
  expect(
    errorCode(run("update actor set issue_end_mail_off = 1 where id = 'hana'")),
  ).toBe("no error");
});

test.each([
  ["a bot turning the ending email off", "alpha", 1, "SQLITE_CONSTRAINT_CHECK"],
  ["a flag other than 0 or 1", "hana", 2, "SQLITE_CONSTRAINT_CHECK"],
  ["a null flag", "hana", null, "SQLITE_CONSTRAINT_NOTNULL"],
])("%s is refused", (_, id, flag, code) => {
  expect(
    errorCode(() =>
      db.$client
        .prepare("update actor set issue_end_mail_off = ? where id = ?")
        .run(flag, id),
    ),
  ).toBe(code);
});

test("a new actor has mail on and no handler", () => {
  insert("actor", {
    id: "beta",
    kind: "bot",
    display_name: "beta",
    created_at: 5,
  })();
  expect(
    rows(
      db,
      "select handler_id, issue_end_mail_off from actor where id = 'beta'",
    ),
  ).toEqual([{ handler_id: null, issue_end_mail_off: 0 }]);
});

const newIssue = (fields: Record<string, unknown>) =>
  insert("issue", {
    id: "i2",
    product_id: "p1",
    number: 2,
    type: "issue",
    title: "another",
    created_by: "alpha",
    created_at: 5,
    updated_at: 5,
    ...fields,
  });

test("an issue can be filed for a person", () => {
  expect(errorCode(newIssue({ filed_for_id: "hana" }))).toBe("no error");
});

test("an issue can't be filed for an unknown actor", () => {
  expect(errorCode(newIssue({ filed_for_id: "nobody" }))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
});

const mail = (fields: Record<string, unknown>) =>
  insert("issue_end_mail", {
    id: "m1",
    issue_id: "i1",
    recipient_id: "hana",
    event_id: "e1",
    status: "done",
    comment_id: "c1",
    next_attempt_at: 10,
    created_at: 10,
    ...fields,
  });

test("an ending's email starts pending with no attempts", () => {
  expect(errorCode(mail({}))).toBe("no error");
  expect(
    rows(
      db,
      "select state, attempts, last_error, sent_at from issue_end_mail where id = 'm1'",
    ),
  ).toEqual([
    { state: "pending", attempts: 0, last_error: null, sent_at: null },
  ]);
});

test("an ending is emailed to a recipient once", () => {
  mail({})();
  expect(errorCode(mail({ id: "m2" }))).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

test("an ending can be emailed to a second recipient", () => {
  mail({})();
  expect(errorCode(mail({ id: "m2", recipient_id: "alpha" }))).toBe("no error");
});

test("an email without the comment is accepted", () => {
  expect(errorCode(mail({ comment_id: null }))).toBe("no error");
});

test("a sent email carries when it was sent", () => {
  expect(errorCode(mail({ state: "sent", attempts: 1, sent_at: 11 }))).toBe(
    "no error",
  );
});

test.each([
  [
    "a status the ending can't have",
    { status: "open" },
    "SQLITE_CONSTRAINT_CHECK",
  ],
  ["an unknown state", { state: "queued" }, "SQLITE_CONSTRAINT_CHECK"],
  ["negative attempts", { attempts: -1 }, "SQLITE_CONSTRAINT_CHECK"],
  [
    "a sent email with no sent_at",
    { state: "sent" },
    "SQLITE_CONSTRAINT_CHECK",
  ],
  [
    "an unsent email with a sent_at",
    { sent_at: 11 },
    "SQLITE_CONSTRAINT_CHECK",
  ],
  [
    "no next attempt time",
    { next_attempt_at: null },
    "SQLITE_CONSTRAINT_NOTNULL",
  ],
  ["an unknown issue", { issue_id: "nope" }, "SQLITE_CONSTRAINT_FOREIGNKEY"],
  [
    "an unknown recipient",
    { recipient_id: "nope" },
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  ],
  ["an unknown event", { event_id: "nope" }, "SQLITE_CONSTRAINT_FOREIGNKEY"],
  [
    "an unknown comment",
    { comment_id: "nope" },
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  ],
])("an email with %s is refused", (_, fields, code) => {
  expect(errorCode(mail(fields))).toBe(code);
});

test("the worker reads the pending head and retention reads finished rows by index", () => {
  const plan = (sql: string) =>
    (rows(db, `explain query plan ${sql}`) as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");
  expect(
    plan(
      "select id from issue_end_mail where state = 'pending' and next_attempt_at <= 99 order by next_attempt_at limit 10",
    ),
  ).toContain("issue_end_mail_pending_idx");
  expect(
    plan(
      "select id from issue_end_mail where state <> 'pending' and created_at < 99",
    ),
  ).toContain("issue_end_mail_finished_idx");
});
