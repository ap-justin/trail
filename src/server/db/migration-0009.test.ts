import { createHash } from "node:crypto";
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
import { authenticateKey } from "../service/keys.js";
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

// real tokens, so the pre-migration rows can be authenticated rather than just selected
const token = (prefix: string) => `trail_${prefix}_${"s".repeat(43)}`;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const live = token("abcd1234");
const revoked = token("cdef5678");

test("a database holding 0008 keys keeps every key, unscoped, and still authenticates the live one", () => {
  const db = openDatabase(join(dir, "live.db"));
  migrate(db, through(8));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values
      ('b1', 'bot', 'Tara', 'agt_1', 0), ('b2', 'bot', 'Uma', 'agt_2', 0);
    insert into api_key (id, actor_id, actor_kind, prefix, hash, created_at, revoked_at) values
      ('k1', 'b1', 'bot', 'abcd1234', '${sha256(live)}', 0, null),
      ('k2', 'b2', 'bot', 'cdef5678', '${sha256(revoked)}', 1, 5);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p1', 'TRL', 'trail', 'b1', 0, 0);
  `);
  const before = rows(db, "select * from api_key order by id");

  migrate(db, through(9));

  expect(rows(db, "select * from api_key order by id")).toEqual(
    (before as object[]).map((r) => ({ ...r, actions: null })),
  );
  expect(rows(db, "select * from api_key_project")).toEqual([]);
  // the server's queries name every current column, so they run on a file migrated to the end
  migrate(db);
  expect(authenticateKey(db, live)).toMatchObject({
    id: "b1",
    displayName: "Tara",
    scope: { projects: null, actions: null },
  });
  expect(authenticateKey(db, revoked)).toBeNull();

  // the allowlist table takes a row on the migrated file, and then scopes that same key
  db.$client.exec(
    "insert into api_key_project (api_key_id, project_id) values ('k1', 'p1')",
  );
  expect(authenticateKey(db, live)?.scope).toEqual({
    projects: [{ id: "p1", key: "TRL" }],
    actions: null,
  });
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  db.$client.close();
});
