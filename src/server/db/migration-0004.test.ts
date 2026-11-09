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

const dir = mkdtempSync(join(tmpdir(), "trail-0004-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations cut back to 0003, the schema live databases hold
function through0003(): string {
  const folder = join(dir, "migrations-0003");
  cpSync(fileURLToPath(new URL("./migrations", import.meta.url)), folder, {
    recursive: true,
  });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 3);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

let files = 0;
function liveDb(seed: string): Db {
  const db = openDatabase(join(dir, `live-${files++}.db`));
  migrate(db, through0003());
  db.$client.exec(seed);
  return db;
}

const rows = (db: Db, sql: string) => db.$client.prepare(sql).all();

const live = `
  insert into actor (id, kind, display_name, created_at) values
    ('b1', 'bot', 'Tara', 0), ('b2', 'bot', 'fly-smoke', 0);
  insert into project (id, key, name, created_by, created_at, updated_at, issue_seq) values ('p', 'TRL', 'trail', 'b1', 0, 0, 2);
  insert into issue (id, project_id, number, title, created_by, created_at, updated_at) values
    ('i1', 'p', 1, 'first', 'b1', 1, 1), ('i2', 'p', 2, 'second', 'b1', 2, 2);
`;

test("a live database keeps its issues with no source key, and bot names become unique ignoring case", () => {
  const db = liveDb(live);

  migrate(db);

  expect(rows(db, "select id, source_key from issue order by id")).toEqual([
    { id: "i1", source_key: null },
    { id: "i2", source_key: null },
  ]);
  const insertBot = (id: string, kind: string, name: string) =>
    db.$client
      .prepare(
        "insert into actor (id, kind, display_name, created_at) values (?, ?, ?, 0)",
      )
      .run(id, kind, name);
  expect(() => insertBot("b3", "bot", "tara")).toThrow(
    expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }),
  );
  expect(() => insertBot("h1", "human", "tara")).not.toThrow();
  const setKey = (id: string, key: string | null) =>
    db.$client
      .prepare("update issue set source_key = ? where id = ?")
      .run(key, id);
  setKey("i1", "JUS-5");
  expect(() => setKey("i2", "JUS-5")).toThrow(
    expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }),
  );
  expect(() => setKey("i2", null)).not.toThrow();
  db.$client.close();
});

test("two bots whose names differ only by case fail the migration, leaving the file as it was", () => {
  const db = liveDb(`${live}
    insert into actor (id, kind, display_name, created_at) values ('b3', 'bot', 'tara', 0);
  `);

  expect(() => migrate(db)).toThrow(/UNIQUE constraint failed/);

  const columns = rows(db, "select name from pragma_table_info('issue')");
  expect(columns).not.toContainEqual({ name: "source_key" });
  expect(rows(db, "select count(*) as n from __drizzle_migrations")).toEqual([
    { n: 4 },
  ]);
  expect(rows(db, "select display_name from actor order by id")).toEqual([
    { display_name: "Tara" },
    { display_name: "fly-smoke" },
    { display_name: "tara" },
  ]);
  db.$client.close();
});
