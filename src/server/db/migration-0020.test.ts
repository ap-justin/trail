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
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";
import { githubPullRequest } from "./schema.js";

const shipped = fileURLToPath(new URL("./migrations", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "trail-0020-"));
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

const PR = "https://github.com/acme/widgets/pull/42";

let db: Db;

// a database as it stood at 0019, with an item carrying a pull request link
beforeAll(() => {
  db = openDatabase(join(dir, "pulls.db"));
  migrate(db, through(19));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('alpha', 'bot', 'alpha', 0);
    insert into product (id, key, name, created_by, created_at, updated_at) values ('p1', 'ATL', 'atlas', 'alpha', 0, 0);
  `);
  migrate(db);
  return () => db.$client.close();
});

const insertRaw = (fields: Record<string, unknown>) => () => {
  const row = { url: PR, last_read_at: 1, ...fields };
  const columns = Object.keys(row);
  db.$client
    .prepare(
      `insert into github_pull_request (${columns.join(", ")}) values (${columns.map((k) => `@${k}`).join(", ")})`,
    )
    .run(row);
};

test("the migration only adds the table: existing rows stay, foreign keys stay clean", () => {
  expect(rows(db, "select id from actor")).toEqual([{ id: "alpha" }]);
  expect(rows(db, "select id from product")).toEqual([{ id: "p1" }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  expect(
    rows(
      db,
      "select strict from pragma_table_list where name = 'github_pull_request'",
    ),
  ).toEqual([{ strict: 1 }]);
});

test("a link read for the first time is unfetched: no state, no checks, no failures", () => {
  const read = new Date(1_000);
  const row = db
    .insert(githubPullRequest)
    .values({ url: PR, lastReadAt: read })
    .returning()
    .get();
  expect(row).toEqual({
    url: PR,
    state: null,
    checkedAt: null,
    attemptedAt: null,
    failures: 0,
    lastReadAt: read,
  });
  expect(errorCode(insertRaw({}))).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
  db.$client.exec("delete from github_pull_request");
});

test.each([
  ["an unknown state", { state: "approved", checked_at: 1, attempted_at: 1 }],
  ["a state with no successful fetch", { state: "open" }],
  ["a successful fetch with no state", { checked_at: 1, attempted_at: 1 }],
  ["a successful fetch with no attempt", { state: "open", checked_at: 1 }],
  ["failures with no attempt", { failures: 1 }],
  ["negative failures", { failures: -1, attempted_at: 1 }],
])("%s is refused", (_, fields) => {
  expect(errorCode(insertRaw(fields))).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("last_read_at is required", () => {
  expect(errorCode(insertRaw({ last_read_at: null }))).toBe(
    "SQLITE_CONSTRAINT_NOTNULL",
  );
});

test.each([
  ["", false],
  ["https://github.com/acme/widgets/pull/1", true],
  ["https://github.com/a/b/pull/1234567", true],
  ["https://github.com/acme/pull/pull/7", true],
  ["http://github.com/acme/widgets/pull/42", false],
  ["https://github.com/acme/widgets/pull/42/files", false],
  ["https://github.com/acme/widgets/pull/42/", false],
  ["https://github.com/acme/widgets/pull/42?w=1", false],
  ["https://github.com/acme/widgets/pull/42#top", false],
  ["https://github.com/acme/widgets/pull/", false],
  ["https://github.com/acme/widgets/pull/0", false],
  ["https://github.com/acme/widgets/pull/4x2", false],
  ["https://github.com/acme/widgets/issues/42", false],
  ["https://github.com/acme//pull/42", false],
  ["https://github.com/acme/wid gets/pull/42", false],
])("the url %j is canonical: %s", (url, ok) => {
  expect(errorCode(insertRaw({ url }))).toBe(
    ok ? "no error" : "SQLITE_CONSTRAINT_CHECK",
  );
  db.$client.exec("delete from github_pull_request");
});

test("each state, once fetched, is accepted", () => {
  for (const [i, state] of ["open", "draft", "merged", "closed"].entries()) {
    expect(
      errorCode(
        insertRaw({
          url: `https://github.com/acme/widgets/pull/${i + 1}`,
          state,
          checked_at: 1,
          attempted_at: 2,
          failures: 0,
        }),
      ),
    ).toBe("no error");
  }
  db.$client.exec("delete from github_pull_request");
});

test("the refresh queue reads links read in the last day off the last_read_at index", () => {
  const plan = (
    rows(
      db,
      "explain query plan select * from github_pull_request where last_read_at > ?",
      0,
    ) as { detail: string }[]
  ).map((r) => r.detail);
  expect(plan).toEqual([
    "SEARCH github_pull_request USING INDEX github_pull_request_last_read_idx (last_read_at>?)",
  ]);
});
