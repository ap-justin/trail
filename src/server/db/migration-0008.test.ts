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

const dir = mkdtempSync(join(tmpdir(), "trail-0008-"));
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

const plan = (db: Db, sql: string) =>
  (rows(db, `explain query plan ${sql}`) as { detail: string }[])
    .map((r) => r.detail)
    .join("\n");

const open: Db[] = [];
afterAll(() => {
  for (const db of open) db.$client.close();
});

let dbCount = 0;
/** A fresh database at 0007 holding the activity events of two bots in two projects. */
function seededAt7(): Db {
  const db = openDatabase(join(dir, `live-${++dbCount}.db`));
  open.push(db);
  migrate(db, through(7));
  db.$client.exec(`
    insert into actor (id, kind, display_name, label, created_at) values
      ('b1', 'bot', 'Tara', 'agt_1', 0), ('b2', 'bot', 'Uma', 'agt_2', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p1', 'TRL', 'trail', 'b1', 0, 0), ('p2', 'OPS', 'ops', 'b2', 0, 0);
    insert into issue (id, project_id, number, title, created_by, created_at, updated_at) values
      ('i1', 'p1', 1, 'first', 'b1', 0, 0);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, payload, created_at) values
      ('e1', 1, 'b1', 'issue', 'i1', 'p1', 'issue.created', '{}', 0),
      ('e2', 2, 'b2', 'issue', 'i1', 'p1', 'issue.updated', '{"status":{"from":"todo","to":"done"}}', 1),
      ('e3', 3, 'b2', 'project', 'p2', 'p2', 'project.created', '{}', 2);
  `);
  return db;
}

/** The seeded database after 0008. */
function seededAt8(): Db {
  const db = seededAt7();
  migrate(db, through(8));
  return db;
}

test("a database holding 0007 activity keeps every event and gains both indexes", () => {
  const db = seededAt7();
  const before = rows(db, "select * from activity_event order by seq");

  migrate(db, through(8));

  expect(rows(db, "select * from activity_event order by seq")).toEqual(before);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  const columns = (index: string) =>
    rows(db, "select name from pragma_index_info(?) order by seqno", index).map(
      (r) => (r as { name: string }).name,
    );
  expect(columns("activity_event_actor_project_idx")).toEqual([
    "actor_id",
    "project_id",
  ]);
  expect(columns("activity_event_subject_seq_idx")).toEqual([
    "subject_id",
    "seq",
  ]);
});

test("an issue's timeline searches by subject in seq order, with no sort step", () => {
  const db = seededAt8();
  const detail = plan(
    db,
    `select * from activity_event
     where subject_type = 'issue' and subject_id = 'i1' and action = 'issue.updated'
     order by seq`,
  );
  expect(detail).toContain("USING INDEX activity_event_subject_seq_idx");
  expect(detail).not.toContain("TEMP B-TREE");
});

test("the bots acting in a set of projects probe each bot by actor and project", () => {
  const db = seededAt8();
  const detail = plan(
    db,
    `select a.id from actor a
     where a.kind = 'bot' and exists (
       select 1 from activity_event e where e.actor_id = a.id and e.project_id in ('p1', 'p2'))
     order by a.display_name`,
  );
  expect(detail).toContain(
    "USING COVERING INDEX activity_event_actor_project_idx (actor_id=? AND project_id=?)",
  );
});
