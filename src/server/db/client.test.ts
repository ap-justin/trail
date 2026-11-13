import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
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
    { name: "account", strict: 1 },
    { name: "activity_event", strict: 1 },
    { name: "actor", strict: 1 },
    { name: "actor_photo", strict: 1 },
    { name: "api_key", strict: 1 },
    { name: "api_key_project", strict: 1 },
    { name: "comment", strict: 1 },
    { name: "idempotency_key", strict: 1 },
    { name: "invite", strict: 1 },
    { name: "issue", strict: 1 },
    { name: "issue_label", strict: 1 },
    { name: "issue_link", strict: 1 },
    { name: "label", strict: 1 },
    { name: "project", strict: 1 },
    { name: "project_member", strict: 1 },
    { name: "project_status_update", strict: 1 },
    { name: "session", strict: 1 },
    { name: "user", strict: 1 },
    { name: "verification", strict: 1 },
    { name: "webhook_delivery", strict: 1 },
    { name: "webhook_subscription", strict: 1 },
    { name: "webhook_subscription_project", strict: 1 },
  ]);
  db.$client.close();
});

const shippedMigrations = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

// shipped migrations plus one more, journaled the way drizzle-kit writes it
function migrationsWith(
  tag: string,
  statements: string[],
): { folder: string; when: number } {
  const folder = join(dir, `migrations-${tag}`);
  cpSync(shippedMigrations, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const when = journal.entries.at(-1).when + 1;
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(
    join(folder, `${tag}.sql`),
    statements.join("\n--> statement-breakpoint\n"),
  );
  return { folder, when };
}

// a drizzle-kit-shaped rebuild of `project`, which `issue` references
const migrationsWithProjectRebuild = () =>
  migrationsWith("9999_rebuild", [
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_project` (`id` text PRIMARY KEY NOT NULL, `key` text NOT NULL UNIQUE, `name` text NOT NULL, `description` text DEFAULT '' NOT NULL, `issue_seq` integer DEFAULT 0 NOT NULL, `external_ref` text, `created_by` text NOT NULL REFERENCES `actor`(`id`), `created_at` integer NOT NULL, `updated_at` integer NOT NULL) STRICT;",
    "INSERT INTO `__new_project` SELECT * FROM `project`;",
    "DROP TABLE `project`;",
    "ALTER TABLE `__new_project` RENAME TO `project`;",
    "PRAGMA foreign_keys=ON;",
  ]);

function seedIssue(db: Db) {
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('b', 'bot', 'builder', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values ('p', 'TRL', 'trail', 'b', 0, 0);
    insert into issue (id, project_id, number, title, created_by, created_at, updated_at) values ('i', 'p', 1, 'keep me', 'b', 0, 0);
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

// a migration that fails partway, as a NOT NULL copy onto existing rows does
const failingMigration = () =>
  migrationsWith("9999_fails", [
    "CREATE INDEX `issue_title_idx` ON `issue` (`title`);",
    "INSERT INTO `issue` (`id`) VALUES ('no title');",
  ]);

test("a retried failing migration reports its own error, not the backup's", () => {
  const db = openDatabase(join(dir, "retry.db"));
  migrate(db);
  const next = failingMigration();

  expect(() => migrate(db, next.folder)).toThrow(/NOT NULL/);
  expect(() => migrate(db, next.folder)).toThrow(/NOT NULL/);
  db.$client.close();
});

test("a file restored from the pre-migration backup boots into the migration's own error", () => {
  const path = join(dir, "restore.db");
  let db = openDatabase(path);
  migrate(db);
  seedIssue(db);
  const next = failingMigration();
  expect(() => migrate(db, next.folder)).toThrow(/NOT NULL/);
  db.$client.close();

  for (const sidecar of ["-wal", "-shm"])
    rmSync(path + sidecar, { force: true });
  cpSync(`${path}.pre-${next.when}.bak`, path);
  db = openDatabase(path);

  expect(() => migrate(db, next.folder)).toThrow(/NOT NULL/);
  expect(db.$client.prepare("select title from issue").pluck().get()).toBe(
    "keep me",
  );
  db.$client.close();
});

// a migrated file in a directory of its own, with backups from earlier runs beside it
function withOldBackups(name: string, stamps: number[]) {
  const path = join(dir, name, "trail.db");
  const db = openDatabase(path);
  migrate(db);
  for (const n of stamps) writeFileSync(`${path}.pre-${n}.bak`, "older run");
  return { path, db };
}

const backupsBeside = (path: string) =>
  readdirSync(dirname(path))
    .filter((f) => f.includes(".bak"))
    .sort();

test("a migration keeps only the newest two backups", () => {
  const { path, db } = withOldBackups("prune", [1, 2, 3, 4]);
  const next = migrationsWithProjectRebuild();

  migrate(db, next.folder);

  expect(backupsBeside(path)).toEqual(
    [`trail.db.pre-${next.when}.bak`, "trail.db.pre-4.bak"].sort(),
  );
  db.$client.close();
});

test("a boot with no migration pending still keeps only the newest two backups", () => {
  const { path, db } = withOldBackups("prune-no-migration", [1, 2, 3, 4]);

  migrate(db);

  expect(backupsBeside(path)).toEqual(
    ["trail.db.pre-3.bak", "trail.db.pre-4.bak"].sort(),
  );
  db.$client.close();
});

test("backups are ranked by their stamp as a number, not as text", () => {
  const { path, db } = withOldBackups("prune-numeric", [9, 10]);
  const next = migrationsWithProjectRebuild();

  migrate(db, next.folder);

  expect(backupsBeside(path)).toEqual(
    [`trail.db.pre-${next.when}.bak`, "trail.db.pre-10.bak"].sort(),
  );
  db.$client.close();
});

test("the backup this migration made survives even when two newer ones exist", () => {
  const next = migrationsWithProjectRebuild();
  const newer = [next.when + 1, next.when + 2];
  const { path, db } = withOldBackups("prune-keeps-own", [1, ...newer]);

  migrate(db, next.folder);

  expect(backupsBeside(path)).toEqual(
    [next.when, ...newer].map((n) => `trail.db.pre-${n}.bak`).sort(),
  );
  db.$client.close();
});

test("pruning leaves partial copies, other databases' backups and look-alikes alone", () => {
  const { path, db } = withOldBackups("prune-others", [1, 2, 3]);
  const folder = dirname(path);
  const untouched = [
    "trail.db.pre-1.bak.partial",
    "other.db.pre-1.bak",
    "xtrail.db.pre-1.bak",
    "trail.db.pre-1.bak.old",
    "trail.db.pre-.bak",
    "trail.db.pre-1a.bak",
  ];
  for (const file of untouched) writeFileSync(join(folder, file), "not mine");

  migrate(db, migrationsWithProjectRebuild().folder);

  for (const file of untouched)
    expect(existsSync(join(folder, file))).toBe(true);
  expect(existsSync(`${path}.pre-1.bak`)).toBe(false);
  db.$client.close();
});

test("a failed migration prunes nothing", () => {
  const { path, db } = withOldBackups("prune-failed", [1, 2, 3]);
  const next = failingMigration();

  expect(() => migrate(db, next.folder)).toThrow(/NOT NULL/);

  expect(backupsBeside(path)).toEqual(
    [1, 2, 3, next.when].map((n) => `trail.db.pre-${n}.bak`).sort(),
  );
  db.$client.close();
});

test("a backup that can't be deleted is warned about and the rest still go", () => {
  const { path, db } = withOldBackups("prune-undeletable", [1, 3]);
  // rmSync without `recursive` refuses a directory
  mkdirSync(`${path}.pre-2.bak`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    expect(() =>
      migrate(db, migrationsWithProjectRebuild().folder),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("trail.db.pre-2.bak"),
      expect.anything(),
    );
  } finally {
    warn.mockRestore();
  }
  expect(existsSync(`${path}.pre-2.bak`)).toBe(true);
  expect(existsSync(`${path}.pre-1.bak`)).toBe(false);
  db.$client.close();
});

test("a copy cut off mid-write is replaced, not kept as the backup", () => {
  const path = join(dir, "killed.db");
  const db = openDatabase(path);
  migrate(db);
  seedIssue(db);
  const next = migrationsWithProjectRebuild();
  const backup = `${path}.pre-${next.when}.bak`;
  writeFileSync(`${backup}.partial`, "half a database");

  migrate(db, next.folder);

  const restored = openDatabase(backup);
  expect(
    restored.$client.prepare("select title from issue").pluck().get(),
  ).toBe("keep me");
  restored.$client.close();
  db.$client.close();
});
