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

const dir = mkdtempSync(join(tmpdir(), "trail-0005-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations cut back to 0004, the schema live databases hold
function through0004(): string {
  const folder = join(dir, "migrations-0004");
  cpSync(fileURLToPath(new URL("./migrations", import.meta.url)), folder, {
    recursive: true,
  });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 4);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const rows = (db: Db, sql: string) => db.$client.prepare(sql).all();

const tables = [
  "actor",
  "api_key",
  "project",
  "issue",
  "label",
  "issue_label",
  "issue_link",
  "project_status_update",
  "idempotency_key",
  "comment",
  "activity_event",
];

test("a live database keeps every row, and its humans start with no GitHub login", () => {
  const db = openDatabase(join(dir, "live.db"));
  migrate(db, through0004());
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, label, created_at) values
      ('b1', 'bot', 'Tara', null, 'agt_1', 0), ('h1', 'human', 'Justin', 89639563, null, 0);
    insert into api_key (id, actor_id, actor_kind, prefix, hash, created_at) values
      ('k1', 'b1', 'bot', 'trl_ab', '${"a".repeat(64)}', 0);
    insert into project (id, key, name, created_by, created_at, updated_at, issue_seq) values
      ('p', 'TRL', 'trail', 'b1', 0, 0, 1);
    insert into issue (id, project_id, number, title, created_by, source_key, created_at, updated_at) values
      ('i1', 'p', 1, 'first', 'b1', 'JUS-1', 1, 1);
    insert into label (id, project_id, name, created_at) values ('l1', 'p', 'bug', 0);
    insert into issue_label (issue_id, label_id, project_id) values ('i1', 'l1', 'p');
    insert into issue_link (id, issue_id, url, title, created_at) values ('u1', 'i1', 'https://x', 'x', 0);
    insert into project_status_update (id, project_id, author_id, body, health, created_at) values
      ('s1', 'p', 'b1', 'fine', 'on_track', 0);
    insert into idempotency_key (actor_id, key, scope, request_hash, response, created_at) values
      ('b1', 'k', 'project.create', 'h', '{}', 0);
    insert into comment (id, issue_id, author_id, body, created_at) values ('c1', 'i1', 'h1', 'hi', 0);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, created_at) values
      ('e1', 1, 'b1', 'issue', 'i1', 'p', 'issue.create', 0);
  `);
  const allRows = () =>
    Object.fromEntries(
      tables.map((t) => [t, rows(db, `select * from ${t} order by 1`)]),
    );
  const before = allRows();

  migrate(db);

  expect(allRows()).toEqual(
    Object.fromEntries(
      Object.entries(before).map(([t, list]) => [
        t,
        t === "actor"
          ? (list as object[]).map((r) => ({ ...r, github_login: null }))
          : list,
      ]),
    ),
  );
  expect(rows(db, "select * from invite")).toEqual([]);
  expect(rows(db, "select * from project_member")).toEqual([]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  db.$client.close();
});

test("an existing bot cannot be given a GitHub login after the migration", () => {
  const db = openDatabase(join(dir, "live-bot.db"));
  migrate(db, through0004());
  db.$client.exec(
    "insert into actor (id, kind, display_name, created_at) values ('b1', 'bot', 'Tara', 0)",
  );
  migrate(db);
  expect(() =>
    db.$client
      .prepare("update actor set github_login = 'tara' where id = 'b1'")
      .run(),
  ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));
  db.$client.close();
});
