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
import { afterAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0006-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations cut back to 0005, the schema live databases hold
function through0005(): string {
  const folder = join(dir, "migrations-0005");
  cpSync(fileURLToPath(new URL("./migrations", import.meta.url)), folder, {
    recursive: true,
  });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 5);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const rows = (db: Db, sql: string) => db.$client.prepare(sql).all();

test("a database holding 0005 data keeps every row and gains empty, STRICT auth tables", () => {
  const db = openDatabase(join(dir, "live.db"));
  migrate(db, through0005());
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, github_login, created_at) values
      ('b1', 'bot', 'Tara', null, null, 0), ('h1', 'human', 'Justin', 89639563, 'justin', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p', 'TRL', 'trail', 'b1', 0, 0);
    insert into invite (username, invited_by, created_at) values ('ada', 'h1', 0);
    insert into project_member (username, project_id, created_at) values ('ada', 'p', 0);
  `);
  const kept = ["actor", "project", "invite", "project_member"];
  const before = kept.map((t) => rows(db, `select * from ${t} order by 1`));

  migrate(db);

  expect(kept.map((t) => rows(db, `select * from ${t} order by 1`))).toEqual(
    before,
  );
  for (const table of ["user", "session", "account", "verification"]) {
    expect(rows(db, `select * from "${table}"`)).toEqual([]);
    expect(
      db.$client
        .prepare("select strict from pragma_table_list where name = ?")
        .pluck()
        .get(table),
    ).toBe(1);
  }
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  db.$client.close();
});
