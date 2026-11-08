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

const dir = mkdtempSync(join(tmpdir(), "trail-0002-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const shippedMigrations = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

// the shipped migrations cut back to the Phase 1 schema, which files in production hold
function phase1Migrations(): string {
  const folder = join(dir, "migrations-phase1");
  cpSync(shippedMigrations, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

let files = 0;
function phase1Db(seed: string): Db {
  const db = openDatabase(join(dir, `phase1-${files++}.db`));
  migrate(db, phase1Migrations());
  db.$client.exec(seed);
  return db;
}

const rows = (db: Db, sql: string) => db.$client.prepare(sql).all();

const actors = `
  insert into actor (id, kind, display_name, created_at) values ('b', 'bot', 'builder', 0);
  insert into actor (id, kind, display_name, github_id, created_at) values ('h', 'human', 'Justin', 1, 0);
`;

test("existing projects get unique keys and their issues numbers from 1 in creation order", () => {
  const db = phase1Db(`${actors}
    insert into project (id, name, created_by, created_at, updated_at) values
      ('p2', 'second', 'b', 20, 20), ('p1', 'first', 'b', 10, 10), ('p3', 'empty', 'b', 30, 30);
    insert into issue (id, project_id, title, created_by, created_at, updated_at) values
      ('i-c', 'p1', 'third', 'b', 300, 0),
      ('i-b', 'p1', 'tie, later id', 'b', 200, 0),
      ('i-a', 'p1', 'tie, earlier id', 'b', 200, 0),
      ('i-z', 'p1', 'first', 'b', 100, 0),
      ('j-a', 'p2', 'only', 'h', 50, 0);
  `);

  migrate(db);

  expect(
    rows(db, "select id, key, issue_seq from project order by created_at"),
  ).toEqual([
    { id: "p1", key: "P1", issue_seq: 4 },
    { id: "p2", key: "P2", issue_seq: 1 },
    { id: "p3", key: "P3", issue_seq: 0 },
  ]);
  expect(
    rows(db, "select id, number from issue order by project_id, number"),
  ).toEqual([
    { id: "i-z", number: 1 },
    { id: "i-a", number: 2 },
    { id: "i-b", number: 3 },
    { id: "i-c", number: 4 },
    { id: "j-a", number: 1 },
  ]);
  db.$client.close();
});

test("done and canceled issues are completed at their last update, the rest not at all", () => {
  const db = phase1Db(`${actors}
    insert into project (id, name, created_by, created_at, updated_at) values ('p', 'trail', 'b', 0, 0);
    insert into issue (id, project_id, title, status, created_by, created_at, updated_at) values
      ('i-open', 'p', 'a', 'open', 'b', 1, 10),
      ('i-wip', 'p', 'b', 'in_progress', 'b', 2, 20),
      ('i-done', 'p', 'c', 'done', 'b', 3, 30),
      ('i-cxl', 'p', 'd', 'canceled', 'b', 4, 40);
  `);

  migrate(db);

  expect(rows(db, "select id, completed_at from issue order by id")).toEqual([
    { id: "i-cxl", completed_at: 40 },
    { id: "i-done", completed_at: 30 },
    { id: "i-open", completed_at: null },
    { id: "i-wip", completed_at: null },
  ]);
  db.$client.close();
});

test("bots sharing a name keep it for the earliest, the later ones take their id as a suffix", () => {
  const db = phase1Db(`
    insert into actor (id, kind, display_name, created_at) values
      ('b3', 'bot', 'builder', 5), ('b2', 'bot', 'builder', 0), ('b1', 'bot', 'builder', 0),
      ('r', 'bot', 'reviewer', 0);
    insert into actor (id, kind, display_name, github_id, created_at) values
      ('h1', 'human', 'builder', 1, 0), ('h2', 'human', 'builder', 2, 0);
    insert into project (id, name, created_by, created_at, updated_at) values ('p', 'trail', 'b2', 0, 0);
    insert into api_key (id, actor_id, prefix, hash, created_at) values ('k', 'b3', 'trl_x', '${"a".repeat(64)}', 0);
  `);

  migrate(db);

  expect(
    rows(db, "select id, kind, display_name from actor order by id"),
  ).toEqual([
    { id: "b1", kind: "bot", display_name: "builder" },
    { id: "b2", kind: "bot", display_name: "builder (b2)" },
    { id: "b3", kind: "bot", display_name: "builder (b3)" },
    { id: "h1", kind: "human", display_name: "builder" },
    { id: "h2", kind: "human", display_name: "builder" },
    { id: "r", kind: "bot", display_name: "reviewer" },
  ]);
  expect(rows(db, "select created_by from project")).toEqual([
    { created_by: "b2" },
  ]);
  expect(rows(db, "select actor_id from api_key")).toEqual([
    { actor_id: "b3" },
  ]);
  db.$client.close();
});

test("existing events, comments and keys survive, events numbered in the order they were listed", () => {
  const db = phase1Db(`${actors}
    insert into project (id, name, created_by, created_at, updated_at) values ('p', 'trail', 'b', 0, 0);
    insert into issue (id, project_id, title, created_by, created_at, updated_at) values ('i', 'p', 'keep', 'b', 0, 0);
    insert into comment (id, issue_id, author_id, body, created_at) values ('c', 'i', 'h', 'still here', 1);
    insert into api_key (id, actor_id, prefix, hash, created_at) values ('k', 'b', 'trl_x', '${"a".repeat(64)}', 0);
    insert into activity_event (id, actor_id, subject_type, subject_id, project_id, action, payload, created_at) values
      ('e-b', 'b', 'issue', 'i', 'p', 'issue.created', '{"title":"keep"}', 10),
      ('e-a', 'b', 'issue', 'i', 'p', 'issue.updated', '{}', 10),
      ('e-0', 'b', 'project', 'p', 'p', 'project.created', '{}', 5);
  `);

  migrate(db);

  expect(
    rows(db, "select id, seq, payload from activity_event order by seq"),
  ).toEqual([
    { id: "e-0", seq: 1, payload: "{}" },
    { id: "e-a", seq: 2, payload: "{}" },
    { id: "e-b", seq: 3, payload: '{"title":"keep"}' },
  ]);
  expect(rows(db, "select id, issue_id, body from comment")).toEqual([
    { id: "c", issue_id: "i", body: "still here" },
  ]);
  expect(rows(db, "select id, actor_id from api_key")).toEqual([
    { id: "k", actor_id: "b" },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  db.$client.close();
});
