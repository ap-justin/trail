import {
  cpSync,
  existsSync,
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

const dir = mkdtempSync(join(tmpdir(), "trail-client-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("opens a file in a missing directory with WAL, foreign keys and a busy timeout", () => {
  const db = openDatabase(join(dir, "nested", "trail.db"));
  const sqlite = db.$client;
  expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
  sqlite.close();
});

test("migrate builds every table STRICT on an empty file", () => {
  const db = openDatabase(join(dir, "fresh.db"));
  migrate(db);
  const tables = db.$client
    .prepare(
      "select name, strict from pragma_table_list where schema = 'main' and name not like 'sqlite_%' and name not like '__drizzle%' order by name",
    )
    .all();
  expect(tables).toEqual([
    { name: "activity_event", strict: 1 },
    { name: "actor", strict: 1 },
    { name: "api_key", strict: 1 },
    { name: "comment", strict: 1 },
    { name: "issue", strict: 1 },
    { name: "project", strict: 1 },
  ]);
  db.$client.close();
});

const shippedMigrations = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

// shipped migrations plus a drizzle-kit-shaped rebuild of `project`, which `issue` references
function migrationsWithProjectRebuild(): { folder: string; when: number } {
  const folder = join(dir, "migrations-next");
  cpSync(shippedMigrations, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const when = journal.entries.at(-1).when + 1;
  journal.entries.push({
    idx: 1,
    version: "6",
    when,
    tag: "0001_rebuild",
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(
    join(folder, "0001_rebuild.sql"),
    [
      "PRAGMA foreign_keys=OFF;",
      "CREATE TABLE `__new_project` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `description` text DEFAULT '' NOT NULL, `created_by` text NOT NULL REFERENCES `actor`(`id`), `created_at` integer NOT NULL, `updated_at` integer NOT NULL) STRICT;",
      "INSERT INTO `__new_project` SELECT * FROM `project`;",
      "DROP TABLE `project`;",
      "ALTER TABLE `__new_project` RENAME TO `project`;",
      "PRAGMA foreign_keys=ON;",
    ].join("\n--> statement-breakpoint\n"),
  );
  return { folder, when };
}

function seedIssue(db: Db) {
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('b', 'bot', 'builder', 0);
    insert into project (id, name, created_by, created_at, updated_at) values ('p', 'trail', 'b', 0, 0);
    insert into issue (id, project_id, title, created_by, created_at, updated_at) values ('i', 'p', 'keep me', 'b', 0, 0);
  `);
}

test("a table rebuild keeps the rows that reference it, after backing the file up", () => {
  const path = join(dir, "rebuild.db");
  const db = openDatabase(path);
  migrate(db);
  seedIssue(db);
  const next = migrationsWithProjectRebuild();

  migrate(db, next.folder);

  const count = (sql: string) => db.$client.prepare(sql).pluck().get();
  expect(count("select count(*) from project")).toBe(1);
  expect(count("select title from issue where project_id = 'p'")).toBe(
    "keep me",
  );
  expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  const backup = `${path}.pre-${next.when}.bak`;
  expect(existsSync(backup)).toBe(true);
  db.$client.close();
});

test("an older build refuses a file a newer build migrated", () => {
  const db = openDatabase(join(dir, "newer.db"));
  migrate(db, migrationsWithProjectRebuild().folder);

  expect(() => migrate(db)).toThrow(/migrated by a newer trail/);
  db.$client.close();
});
