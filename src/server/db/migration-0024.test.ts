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

const shipped = fileURLToPath(new URL("./migrations", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "trail-0024-"));
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

const errorCode = (sql: string) => {
  try {
    db.$client.exec(sql);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

let db: Db;
let before: unknown[];

// a database as it stood at 0023, with a GitHub person, an email person and a bot
beforeAll(() => {
  db = openDatabase(join(dir, "github-email.db"));
  migrate(db, through(23));
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at)
      values ('hana', 'human', 'Hana', 101, 'hana-example', 1, 0);
    insert into actor (id, kind, display_name, email, created_at)
      values ('ivo', 'human', 'ivo', 'ivo@example.com', 1);
    insert into actor (id, kind, display_name, created_at) values ('alpha', 'bot', 'alpha', 2);
  `);
  before = db.$client.prepare("select * from actor order by id").all();
  migrate(db);
  return () => db.$client.close();
});

test("existing people are kept as they were, with no GitHub email", () => {
  const after = db.$client.prepare("select * from actor order by id").all();
  expect(after).toEqual(
    (before as object[]).map((r) => ({ ...r, github_email: null })),
  );
});

test("an address sits only on a person with a GitHub account, and in the same shape as an invited one", () => {
  const set = (id: string, address: string) =>
    errorCode(
      `update actor set github_email = '${address}' where id = '${id}'`,
    );
  expect(set("hana", "hana@example.com")).toBe("no error");
  expect(set("ivo", "other@example.com")).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(set("alpha", "bot@example.com")).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(set("hana", "Hana@Example.com")).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a GitHub address is held by one person", () => {
  db.$client.exec(
    "update actor set github_email = 'hana@example.com' where id = 'hana'",
  );
  db.$client.exec(
    `insert into actor (id, kind, display_name, github_id, github_login, created_at)
      values ('kay', 'human', 'Kay', 102, 'kay-example', 3)`,
  );
  expect(
    errorCode(
      "update actor set github_email = 'hana@example.com' where id = 'kay'",
    ),
  ).toBe("SQLITE_CONSTRAINT_UNIQUE");
});
