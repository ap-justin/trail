import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "./schema.js";

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // drizzle sets no pragmas; journal_mode persists in the file, the rest reset on every open
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDatabase>;

// Resolves beside this module: src/server/db/migrations under tsx, and
// dist/migrations in the bundle, where tsup.config.ts copies the folder.
const migrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

/**
 * Copies the file to `backup` unless a copy is already there: a failed or killed
 * migration leaves the ledger where it was, so an existing backup already holds
 * this pre-migration state, and VACUUM INTO refuses an existing target.
 */
function backUpOnce(sqlite: Db["$client"], backup: string): void {
  if (existsSync(backup)) return;
  // written aside and renamed in, so a kill mid-copy never leaves a partial file under the backup's name
  const partial = `${backup}.partial`;
  rmSync(partial, { force: true });
  // VACUUM INTO copies the whole file (needs its size free on disk); it can't run in a transaction
  sqlite.prepare("vacuum into ?").run(partial);
  renameSync(partial, backup);
}

const backupsKept = 2;

/**
 * Deletes all but the newest `backupsKept` backups of the file at `path`, newest
 * by the migration stamp in the name; the backup named `keep`, when given,
 * survives whatever its stamp. Best effort: a backup that can't be listed or
 * deleted is warned about, never thrown.
 */
function pruneBackups(path: string, keep?: string): void {
  const folder = dirname(path);
  try {
    const stale = readdirSync(folder)
      .flatMap((file) => {
        const stamp = backupStamp(basename(path), file);
        return stamp === undefined ? [] : [{ file, stamp }];
      })
      .sort((a, b) => b.stamp - a.stamp)
      .slice(backupsKept)
      .filter(({ file }) => file !== keep);
    for (const { file } of stale) {
      try {
        rmSync(join(folder, file));
      } catch (error) {
        console.warn(
          `could not delete old backup ${join(folder, file)}:`,
          error,
        );
      }
    }
  } catch (error) {
    console.warn(`could not prune backups of ${path}:`, error);
  }
}

// the stamp in `<name>.pre-<stamp>.bak`; sliced, not a regex on `name`, which may hold regex metacharacters
function backupStamp(name: string, file: string): number | undefined {
  if (!file.startsWith(name)) return undefined;
  const digits = /^\.pre-(\d+)\.bak$/.exec(file.slice(name.length))?.[1];
  return digits === undefined ? undefined : Number(digits);
}

// journal `when` of 0004_issue_source_key_bot_name_ci, which makes bot names unique ignoring case
const botNamesIgnoreCaseMigration = 1794187369175;

/**
 * Throws naming every group of bots 0004's index would reject, since SQLite's own
 * UNIQUE failure names neither row. Renaming stays a person's call: the name is
 * the bot's identity in every activity row.
 */
function refuseBotNamesClashingByCase(sqlite: Db["$client"]): void {
  const clashes = sqlite
    .prepare<[], string>(
      "select group_concat(id || ' (' || display_name || ')', ', ') from actor where kind = 'bot' group by lower(display_name) having count(*) > 1",
    )
    .pluck()
    .all();
  if (clashes.length === 0) return;
  throw new Error(
    `${sqlite.name} has bots whose names differ only by case, which this build makes unique ignoring case: ${clashes.join("; ")}. Rename all but one bot in each group by hand (update actor set display_name = '<new name>' where id = '<id>'), then restart.`,
  );
}

/**
 * Applies pending drizzle-kit migrations. Throws, leaving the file untouched,
 * when the file was migrated by a newer build than this one, or holds bots
 * whose names differ only by case while 0004 is pending. A run that commits,
 * migrating or not, then deletes all but the newest `backupsKept` backups.
 */
export function migrate(db: Db, folder = migrationsFolder): void {
  const sqlite = db.$client;
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const newest = migrations.at(-1)?.folderMillis ?? 0;
  // drizzle-kit's ledger shape, so `drizzle-kit migrate` reads the same history
  sqlite.exec(
    "create table if not exists __drizzle_migrations (id integer primary key, hash text not null, created_at numeric)",
  );
  const lastApplied = () =>
    sqlite
      .prepare<[], number>(
        "select created_at from __drizzle_migrations order by created_at desc limit 1",
      )
      .pluck()
      .get();

  const before = lastApplied();
  const backup =
    before !== undefined && before < newest && sqlite.name !== ":memory:"
      ? `${sqlite.name}.pre-${newest}.bak`
      : undefined;
  if (backup) backUpOnce(sqlite, backup);

  // foreign_keys is a no-op inside a transaction, so drizzle-kit's own toggle in a
  // table rebuild does nothing and its DROP TABLE trips (or cascades to) referencing rows;
  // switch it off out here
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite
      .transaction(() => {
        const last = lastApplied();
        if (last !== undefined && last > newest) {
          throw new Error(
            `${sqlite.name} was migrated by a newer trail (migration ${last}; this build knows up to ${newest})`,
          );
        }
        const record = sqlite.prepare(
          "insert into __drizzle_migrations (hash, created_at) values (?, ?)",
        );
        for (const m of migrations) {
          if (last !== undefined && m.folderMillis <= last) continue;
          // checked against the rows earlier steps leave (0002 renames exact twins); a fresh file has no bots
          if (
            last !== undefined &&
            m.folderMillis === botNamesIgnoreCaseMigration
          ) {
            refuseBotNamesClashingByCase(sqlite);
          }
          for (const statement of m.sql) sqlite.exec(statement);
          record.run(m.hash, m.folderMillis);
        }
        const violations = sqlite.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration left foreign key violations: ${JSON.stringify(violations)}`,
          );
        }
      })
      // read-then-write: deferred would hit SQLITE_BUSY with no busy_timeout retry
      .immediate();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  if (sqlite.name !== ":memory:") {
    pruneBackups(sqlite.name, backup && basename(backup));
  }
  sqlite.pragma("optimize");
}
