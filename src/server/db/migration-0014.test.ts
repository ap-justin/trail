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
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";
import { actor } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0014-"));
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

const errorCode = (write: () => unknown) => {
  try {
    write();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

let db: Db;

beforeAll(() => {
  db = openDatabase(join(dir, "titles.db"));
  migrate(db, through(13));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values
      ('b1', 'bot', 'builder', 'agt_1', 0);
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at) values
      ('h1', 'human', 'Ada', 7, 'ada', 1, 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values ('p1', 'TRL', 'trail', 'b1', 0, 0);
  `);
  migrate(db, through(14));
  return () => db.$client.close();
});

afterEach(() => {
  db.$client.exec("update actor set title = null where id = 'b1'");
  db.$client.exec("delete from actor where id not in ('b1', 'h1')");
});

const setTitle = (id: string, title: string) => () =>
  db.$client.prepare("update actor set title = ? where id = ?").run(title, id);

test("actors from before 0014 keep their data and carry no title", () => {
  expect(
    rows(
      db,
      "select id, kind, display_name, label, github_id, github_login, is_owner, title from actor order by id",
    ),
  ).toEqual([
    {
      id: "b1",
      kind: "bot",
      display_name: "builder",
      label: "agt_1",
      github_id: null,
      github_login: null,
      is_owner: 0,
      title: null,
    },
    {
      id: "h1",
      kind: "human",
      display_name: "Ada",
      label: null,
      github_id: 7,
      github_login: "ada",
      is_owner: 1,
      title: null,
    },
  ]);
  expect(rows(db, "select id, created_by from project")).toEqual([
    { id: "p1", created_by: "b1" },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("a bot's title round-trips through the drizzle table, and is null when unset", () => {
  const fresh = db
    .insert(actor)
    .values({ kind: "bot", displayName: "reviewer" })
    .returning()
    .get();
  expect(fresh.title).toBeNull();

  db.update(actor)
    .set({ title: "Release captain" })
    .where(eq(actor.id, "b1"))
    .run();
  expect(
    db
      .select({ title: actor.title })
      .from(actor)
      .where(eq(actor.id, "b1"))
      .get(),
  ).toEqual({ title: "Release captain" });
});

test("a title is 1 to 40 characters", () => {
  expect(errorCode(setTitle("b1", ""))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(setTitle("b1", "x".repeat(41)))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  expect(errorCode(setTitle("b1", "x".repeat(40)))).toBe("no error");
  expect(errorCode(setTitle("b1", "x"))).toBe("no error");
});

test("a title is stored trimmed, so a blank one is rejected", () => {
  expect(errorCode(setTitle("b1", "   "))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(setTitle("b1", " Triage"))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(setTitle("b1", "Triage "))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(setTitle("b1", "Triage lead"))).toBe("no error");
});

test("a human never carries a title", () => {
  expect(errorCode(setTitle("h1", "Owner"))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "insert into actor (id, kind, display_name, title, created_at) values ('h2', 'human', 'Grace', 'Admiral', 0)",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});
