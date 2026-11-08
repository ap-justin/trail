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
import { migrate, openDatabase } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0003-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations cut back to 0002, the schema before source_status
function through0002(): string {
  const folder = join(dir, "migrations-0002");
  cpSync(fileURLToPath(new URL("./migrations", import.meta.url)), folder, {
    recursive: true,
  });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 2);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

test("existing issues and their labels survive with no source status", () => {
  const db = openDatabase(join(dir, "trail.db"));
  migrate(db, through0002());
  const columns = () =>
    db.$client
      .prepare("select name from pragma_table_info('issue')")
      .all()
      .map((c) => (c as { name: string }).name);
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('b', 'bot', 'builder', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values ('p', 'TRL', 'trail', 'b', 0, 0);
    insert into issue (id, project_id, number, title, created_by, created_at, updated_at) values
      ('i1', 'p', 1, 'first', 'b', 1, 1), ('i2', 'p', 2, 'second', 'b', 2, 2);
    insert into issue (id, project_id, number, title, status, created_by, created_at, updated_at, completed_at) values
      ('i3', 'p', 3, 'closed', 'done', 'b', 3, 4, 4);
    insert into label (id, project_id, name, created_at) values ('l', 'p', 'bug', 0);
    insert into issue_label (issue_id, label_id, project_id) values ('i1', 'l', 'p');
  `);

  expect(columns()).not.toContain("source_status");

  migrate(db);

  expect(columns()).toContain("source_status");
  const rows = (sql: string) => db.$client.prepare(sql).all();
  expect(
    rows("select id, title, source_status from issue order by id"),
  ).toEqual([
    { id: "i1", title: "first", source_status: null },
    { id: "i2", title: "second", source_status: null },
    { id: "i3", title: "closed", source_status: null },
  ]);
  expect(rows("select completed_at from issue where id = 'i3'")).toEqual([
    { completed_at: 4 },
  ]);
  const setSourceStatus = (length: number) =>
    db.$client
      .prepare("update issue set source_status = ? where id = 'i1'")
      .run("s".repeat(length));
  expect(() => setSourceStatus(200)).not.toThrow();
  expect(() => setSourceStatus(201)).toThrow(
    expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }),
  );
  expect(rows("select issue_id, label_id from issue_label")).toEqual([
    { issue_id: "i1", label_id: "l" },
  ]);
  db.$client.close();
});
