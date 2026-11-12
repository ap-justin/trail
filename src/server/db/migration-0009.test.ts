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

const dir = mkdtempSync(join(tmpdir(), "trail-0009-"));
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

test("a database holding 0008 keys keeps every key, unscoped, and still resolves each by prefix and hash", () => {
  const db = openDatabase(join(dir, "live.db"));
  migrate(db, through(8));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values
      ('b1', 'bot', 'Tara', 'agt_1', 0), ('b2', 'bot', 'Uma', 'agt_2', 0);
    insert into api_key (id, actor_id, actor_kind, prefix, hash, created_at, revoked_at) values
      ('k1', 'b1', 'bot', 'trl_ab', '${"a".repeat(64)}', 0, null),
      ('k2', 'b2', 'bot', 'trl_cd', '${"b".repeat(64)}', 1, 5);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p1', 'TRL', 'trail', 'b1', 0, 0);
  `);
  const before = rows(db, "select * from api_key order by id");

  migrate(db, through(9));

  expect(rows(db, "select * from api_key order by id")).toEqual(
    (before as object[]).map((r) => ({ ...r, actions: null })),
  );
  expect(rows(db, "select * from api_key_project")).toEqual([]);
  expect(
    rows(
      db,
      "select id from api_key where prefix = ? and hash = ?",
      "trl_ab",
      "a".repeat(64),
    ),
  ).toEqual([{ id: "k1" }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  db.$client.close();
});
