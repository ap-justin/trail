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
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0013-"));
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

let db: Db;

beforeAll(() => {
  db = openDatabase(join(dir, "retention.db"));
  migrate(db, through(12));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('b1', 'bot', 'bot-one', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values ('p1', 'TRL', 'trail', 'b1', 0, 0);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, payload, created_at) values
      ('e1', 1, 'b1', 'project', 'p1', 'p1', 'project.created', '{}', 5),
      ('e2', 2, 'b1', 'project', 'p1', 'p1', 'project.updated', '{}', 6),
      ('e3', 3, 'b1', 'project', 'p1', 'p1', 'project.updated', '{}', 7);
    insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values ('s1', 'b1', 'https://x.test/hook', 'sealed', 1, 1);
    insert into webhook_delivery (id, subscription_id, event_id, seq, type, status, body, attempts, next_attempt_at, created_at, delivered_at) values
      ('d-delivered', 's1', 'e1', 1, 'trail.project.created', 'delivered', '{"big":"body"}', 1, 0, 10, 20),
      ('d-failed', 's1', 'e2', 2, 'trail.project.updated', 'failed', '{"kept":"for debugging"}', 3, 0, 11, null),
      ('d-pending', 's1', 'e3', 3, 'trail.project.updated', 'pending', '{"to":"send"}', 0, 0, 12, null);
  `);
  migrate(db, through(13));
  return () => db.$client.close();
});

test("a delivered row loses its body; every other row keeps its own, and no row is lost", () => {
  expect(
    rows(
      db,
      "select id, status, body, attempts, delivered_at from webhook_delivery order by seq",
    ),
  ).toEqual([
    {
      id: "d-delivered",
      status: "delivered",
      body: null,
      attempts: 1,
      delivered_at: 20,
    },
    {
      id: "d-failed",
      status: "failed",
      body: '{"kept":"for debugging"}',
      attempts: 3,
      delivered_at: null,
    },
    {
      id: "d-pending",
      status: "pending",
      body: '{"to":"send"}',
      attempts: 0,
      delivered_at: null,
    },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("expiry and retention each have a partial index of their own, on the status they read", () => {
  const index = (name: string) =>
    rows(
      db,
      "select sql from sqlite_master where type = 'index' and name = ?",
      name,
    ).map((r) => (r as { sql: string }).sql.replace(/\s+/g, " "));
  expect(index("webhook_delivery_pending_age_idx")).toEqual([
    expect.stringMatching(
      /\(`subscription_id`,\s?`created_at`\) WHERE "status" = 'pending'/,
    ),
  ]);
  expect(index("webhook_delivery_delivered_idx")).toEqual([
    expect.stringMatching(/\(`delivered_at`\) WHERE "status" = 'delivered'/),
  ]);
  expect(index("webhook_delivery_failed_idx")).toEqual([
    expect.stringMatching(/\(`created_at`\) WHERE "status" = 'failed'/),
  ]);
  // the one from 0011 stays
  expect(index("webhook_delivery_pending_idx")).toHaveLength(1);
});

test("the planner reads an expiry's rows through the age index, not the whole backlog", () => {
  const plan = rows(
    db,
    "explain query plan update webhook_delivery set status = 'failed' where status = 'pending' and subscription_id = 's1' and created_at < 1",
  ).map((r) => (r as { detail: string }).detail);
  expect(plan.join("\n")).toContain("webhook_delivery_pending_age_idx");
  expect(plan.join("\n")).not.toMatch(/SCAN webhook_delivery( |$)/);
});
