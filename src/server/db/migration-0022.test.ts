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
const dir = mkdtempSync(join(tmpdir(), "trail-0022-"));
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

let db: Db;
let before: unknown[];

// a database as it stood at 0021: two products, one with every optional column set, and an
// item in each, so a change to the product table that touched existing rows or their items shows
beforeAll(() => {
  db = openDatabase(join(dir, "kind.db"));
  migrate(db, through(21));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('alpha', 'bot', 'alpha', 0);
    insert into product (id, key, name, created_by, created_at, updated_at) values ('p1', 'ATL', 'atlas', 'alpha', 0, 0);
    insert into product (id, key, name, description, issue_seq, external_ref, owner_id, repo_url, created_by, created_at, updated_at)
      values ('p2', 'ORB', 'orbit', 'the orbit app', 1, 'ext-2', 'alpha', 'https://github.com/example/orbit', 'alpha', 3, 4);
    insert into issue (id, product_id, number, type, title, status, created_by, created_at, updated_at)
      values ('i1', 'p2', 1, 'todo', 'a todo', 'open', 'alpha', 1, 1);
  `);
  before = rows(db, "select * from product order by id");
  migrate(db);
  return () => db.$client.close();
});

afterEach(() => {
  db.$client.exec("delete from product where id not in ('p1', 'p2')");
});

const insertProduct = (fields: Record<string, unknown>) => () => {
  const row = {
    id: "n1",
    key: "NEW",
    name: "nova",
    created_by: "alpha",
    created_at: 5,
    updated_at: 5,
    ...fields,
  };
  const columns = Object.keys(row);
  db.$client
    .prepare(
      `insert into product (${columns.join(", ")}) values (${columns.map((k) => `@${k}`).join(", ")})`,
    )
    .run(row);
};

test("existing products are kept as they were, with kind 'product'", () => {
  expect(rows(db, "select * from product order by id")).toEqual(
    (before as Record<string, unknown>[]).map((r) => ({
      ...r,
      kind: "product",
    })),
  );
  expect(rows(db, "select id, product_id from issue")).toEqual([
    { id: "i1", product_id: "p2" },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  expect(
    rows(db, "select strict from pragma_table_list where name = 'product'"),
  ).toEqual([{ strict: 1 }]);
});

test("a product inserted without a kind is a product", () => {
  insertProduct({})();
  expect(rows(db, "select kind from product where id = 'n1'")).toEqual([
    { kind: "product" },
  ]);
});

test("a team is accepted", () => {
  expect(errorCode(insertProduct({ kind: "team" }))).toBe("no error");
  expect(rows(db, "select kind from product where id = 'n1'")).toEqual([
    { kind: "team" },
  ]);
});

test.each([
  ["an unknown kind", "group", "SQLITE_CONSTRAINT_CHECK"],
  ["a kind in the wrong case", "Team", "SQLITE_CONSTRAINT_CHECK"],
  ["an empty kind", "", "SQLITE_CONSTRAINT_CHECK"],
  ["a null kind", null, "SQLITE_CONSTRAINT_NOTNULL"],
])("%s is refused", (_, kind, code) => {
  expect(errorCode(insertProduct({ kind }))).toBe(code);
});

test("an existing product can't be changed to an unknown kind", () => {
  expect(
    errorCode(() =>
      db.$client
        .prepare("update product set kind = 'group' where id = 'p1'")
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});
