import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
 * Applies pending drizzle-kit migrations. Throws, leaving the file untouched,
 * when the file was migrated by a newer build than this one.
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
  if (before !== undefined && before < newest && sqlite.name !== ":memory:") {
    // VACUUM INTO copies the whole file (needs its size free on disk); it can't run in a transaction
    sqlite.prepare("vacuum into ?").run(`${sqlite.name}.pre-${newest}.bak`);
  }

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
  sqlite.pragma("optimize");
}
