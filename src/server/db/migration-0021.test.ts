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
const dir = mkdtempSync(join(tmpdir(), "trail-0021-"));
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

// every table holding an item's rows, read whole, so the rebuild is checked row for row
const childTables = [
  "issue",
  "issue_label",
  "issue_link",
  "comment",
  "project_item",
];
const snapshot = (db: Db) =>
  Object.fromEntries(
    childTables.map((t) => [t, rows(db, `select * from ${t} order by 1, 2`)]),
  );

let db: Db;
let before: ReturnType<typeof snapshot>;

// a database as it stood at 0020: an issue and a todo, each with a label, a link, a comment
// and a project, all of which reference the issue table the migration rebuilds; two imported
// items with every column set to a value of its own, so a swapped or dropped column in the copy shows
beforeAll(() => {
  db = openDatabase(join(dir, "notes.db"));
  migrate(db, through(20));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('alpha', 'bot', 'alpha', 0);
    insert into actor (id, kind, display_name, github_id, created_at) values ('maya', 'human', 'Maya', 1001, 0);
    insert into product (id, key, name, owner_id, created_by, created_at, updated_at, issue_seq) values ('p1', 'ATL', 'atlas', 'alpha', 'alpha', 0, 0, 4);
    insert into issue (id, product_id, number, type, title, status, created_by, created_at, updated_at)
      values ('i1', 'p1', 1, 'issue', 'a filed issue', 'triage', 'maya', 1, 1);
    insert into issue (id, product_id, number, type, title, status, assignee_id, created_by, created_at, updated_at, completed_at)
      values ('i2', 'p1', 2, 'todo', 'a done todo', 'done', 'alpha', 'alpha', 2, 3, 3);
    insert into issue (id, product_id, number, type, title, description, status, estimate, priority, assignee_id, created_by, external_ref, source_author, source_status, source_key, created_at, updated_at, completed_at)
      values ('i3', 'p1', 3, 'issue', 'an imported issue', 'steps to reproduce', 'in_progress', 2.5, 3, 'alpha', 'maya', 'ABC-187', 'octocat', 'In Review', 'src-187', 11, 12, null),
             ('i4', 'p1', 4, 'todo', 'an imported todo', 'the details', 'canceled', 0.25, 4, 'maya', 'alpha', 'ABC-188', 'hubot', 'Dropped', 'src-188', 13, 14, 15);
    insert into label (id, product_id, name, created_at) values ('l1', 'p1', 'bug', 0);
    insert into issue_label (issue_id, label_id, product_id) values ('i1', 'l1', 'p1'), ('i2', 'l1', 'p1');
    insert into issue_link (id, issue_id, url, title, created_at) values ('k1', 'i1', 'https://example.com/a', 'a', 0), ('k2', 'i2', 'https://example.com/b', 'b', 0);
    insert into comment (id, issue_id, author_id, body, created_at) values ('c1', 'i1', 'maya', 'seen', 0), ('c2', 'i2', 'alpha', 'shipped', 0);
    insert into project (id, slug, name, lead_id, created_by, created_at, updated_at) values ('pr1', 'launch', 'Launch', 'alpha', 'alpha', 0, 0);
    insert into project_product (project_id, product_id) values ('pr1', 'p1');
    insert into project_item (project_id, issue_id, product_id, added_by, created_at) values ('pr1', 'i1', 'p1', 'alpha', 0), ('pr1', 'i2', 'p1', 'alpha', 0);
  `);
  before = snapshot(db);
  migrate(db);
  return () => db.$client.close();
});

afterEach(() => {
  db.$client.exec(
    "delete from note_about; delete from issue where id not in ('i1', 'i2', 'i3', 'i4')",
  );
});

const insertItem = (fields: Record<string, unknown>) => () => {
  const row = {
    id: "n1",
    product_id: "p1",
    number: 10,
    type: "note",
    title: "a note",
    status: "current",
    created_by: "alpha",
    created_at: 5,
    updated_at: 5,
    ...fields,
  };
  const columns = Object.keys(row);
  db.$client
    .prepare(
      `insert into issue (${columns.join(", ")}) values (${columns.map((k) => `@${k}`).join(", ")})`,
    )
    .run(row);
};

const insertAbout = (noteId: string, itemId: string) => () =>
  db.$client
    .prepare("insert into note_about (note_id, item_id) values (?, ?)")
    .run(noteId, itemId);

test("the rebuild keeps every item and every row that references one, and foreign keys stay clean", () => {
  expect(snapshot(db)).toEqual(before);
  expect(rows(db, "select count(*) as n from issue_label")).toEqual([{ n: 2 }]);
  expect(rows(db, "select count(*) as n from issue")).toEqual([{ n: 4 }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  expect(
    rows(
      db,
      "select name, strict from pragma_table_list where name in ('issue', 'note_about') order by name",
    ),
  ).toEqual([
    { name: "issue", strict: 1 },
    { name: "note_about", strict: 1 },
  ]);
});

test("an imported item comes through the rebuild with every column as it was", () => {
  expect(
    rows(db, "select * from issue where id in ('i3', 'i4') order by id"),
  ).toEqual([
    {
      id: "i3",
      product_id: "p1",
      number: 3,
      type: "issue",
      title: "an imported issue",
      description: "steps to reproduce",
      status: "in_progress",
      estimate: 2.5,
      priority: 3,
      assignee_id: "alpha",
      created_by: "maya",
      external_ref: "ABC-187",
      source_author: "octocat",
      source_status: "In Review",
      source_key: "src-187",
      created_at: 11,
      updated_at: 12,
      completed_at: null,
    },
    {
      id: "i4",
      product_id: "p1",
      number: 4,
      type: "todo",
      title: "an imported todo",
      description: "the details",
      status: "canceled",
      estimate: 0.25,
      priority: 4,
      assignee_id: "maya",
      created_by: "alpha",
      external_ref: "ABC-188",
      source_author: "hubot",
      source_status: "Dropped",
      source_key: "src-188",
      created_at: 13,
      updated_at: 14,
      completed_at: 15,
    },
  ]);
});

test("the issue table keeps its indexes, the three partial ones with their predicates", () => {
  const indexes = rows(
    db,
    `select l.name, l."unique" as "unique", l.partial as partial,
        (select group_concat(i.name) from (select name from pragma_index_info(l.name) order by seqno) i) as columns
      from pragma_index_list('issue') l where l.origin = 'c' order by l.name`,
  );
  expect(indexes).toEqual([
    {
      name: "issue_assignee_created_idx",
      unique: 0,
      partial: 1,
      columns: "assignee_id,created_at,id",
    },
    {
      name: "issue_id_product_unique",
      unique: 1,
      partial: 0,
      columns: "id,product_id",
    },
    {
      name: "issue_product_created_idx",
      unique: 0,
      partial: 0,
      columns: "product_id,created_at,id",
    },
    {
      name: "issue_product_external_ref_unique",
      unique: 1,
      partial: 1,
      columns: "product_id,external_ref",
    },
    {
      name: "issue_product_number_unique",
      unique: 1,
      partial: 0,
      columns: "product_id,number",
    },
    {
      name: "issue_product_status_created_idx",
      unique: 0,
      partial: 0,
      columns: "product_id,status,created_at,id",
    },
    {
      name: "issue_source_key_unique",
      unique: 1,
      partial: 1,
      columns: "source_key",
    },
  ]);
  const predicate = (name: string) =>
    (
      rows(db, "select sql from sqlite_master where name = ?", name) as {
        sql: string;
      }[]
    )[0]?.sql.replace(/^[\s\S]*\bwhere\s+/i, "");
  expect(predicate("issue_product_external_ref_unique")).toBe(
    '"external_ref" is not null',
  );
  expect(predicate("issue_source_key_unique")).toBe('"source_key" is not null');
  expect(predicate("issue_assignee_created_idx")).toBe(
    '"assignee_id" is not null',
  );
});

test("an external ref or source key already taken is refused, one not taken is accepted", () => {
  const issue = { type: "issue", status: "open" };
  expect(
    errorCode(
      insertItem({
        ...issue,
        id: "u1",
        number: 20,
        external_ref: "ABC-999",
        source_key: "src-999",
      }),
    ),
  ).toBe("no error");
  expect(
    errorCode(
      insertItem({ ...issue, id: "u2", number: 21, external_ref: "ABC-187" }),
    ),
  ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(
    errorCode(
      insertItem({ ...issue, id: "u3", number: 22, source_key: "src-188" }),
    ),
  ).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

test.each(["current", "archived"])(
  "a note in status %s is accepted",
  (status) => {
    expect(errorCode(insertItem({ status }))).toBe("no error");
  },
);

test.each([
  ["an unknown type", { type: "memo" }],
  ["an unknown status", { status: "closed" }],
  ["a note in triage", { status: "triage" }],
  ["a note that is open", { status: "open" }],
  ["a note that is done", { status: "done", completed_at: 6 }],
  ["an issue that is current", { type: "issue", status: "current" }],
  ["a todo that is archived", { type: "todo", status: "archived" }],
  ["an assigned note", { assignee_id: "alpha" }],
  ["a note with a priority", { priority: 2 }],
  ["a note with an estimate", { estimate: 1 }],
  [
    "an archived note with completed_at",
    { status: "archived", completed_at: 6 },
  ],
])("%s is refused", (_, fields) => {
  expect(errorCode(insertItem(fields))).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a note is about an item once", () => {
  insertItem({})();
  expect(errorCode(insertAbout("n1", "i1"))).toBe("no error");
  expect(errorCode(insertAbout("n1", "i2"))).toBe("no error");
  expect(errorCode(insertAbout("n1", "i1"))).toBe(
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );
});

test("a note is not about itself", () => {
  insertItem({})();
  expect(errorCode(insertAbout("n1", "n1"))).toBe("SQLITE_CONSTRAINT_CHECK");
});

test.each([
  ["a missing note", "nope", "i1"],
  ["a missing item", "n1", "nope"],
])("about naming %s is refused", (_, noteId, itemId) => {
  insertItem({})();
  expect(errorCode(insertAbout(noteId, itemId))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
});

test("deleting the note deletes what it is about", () => {
  insertItem({})();
  insertAbout("n1", "i1")();
  db.$client.exec("delete from issue where id = 'n1'");
  expect(rows(db, "select * from note_about")).toEqual([]);
});

test("deleting the item deletes the notes' pointers to it, not the notes", () => {
  insertItem({})();
  insertItem({
    id: "x1",
    number: 11,
    title: "a doomed issue",
    type: "issue",
    status: "open",
  })();
  insertAbout("n1", "x1")();
  insertAbout("n1", "i1")();
  db.$client.exec("delete from issue where id = 'x1'");
  expect(rows(db, "select note_id, item_id from note_about")).toEqual([
    { note_id: "n1", item_id: "i1" },
  ]);
  expect(rows(db, "select id from issue where id = 'n1'")).toEqual([
    { id: "n1" },
  ]);
});

test("the notes about an item are read off the item index", () => {
  const plan = (
    rows(
      db,
      "explain query plan select note_id from note_about where item_id = ?",
      "i1",
    ) as { detail: string }[]
  ).map((r) => r.detail);
  expect(plan.join("\n")).toMatch(/\bnote_about_item_note_idx\b/);
  expect(plan.join("\n")).not.toMatch(/\bSCAN\b/);
});
