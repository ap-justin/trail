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

const dir = mkdtempSync(join(tmpdir(), "trail-0011-"));
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
  db = openDatabase(join(dir, "webhooks.db"));
  migrate(db, through(10));
  // what 0011 finds when it runs: actors, a project and its activity already written
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at) values
      ('o', 'human', 'Olive', 1, 'olive', 1, 0);
    insert into actor (id, kind, display_name, created_at) values ('b1', 'bot', 'bot-one', 0), ('b2', 'bot', 'bot-two', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p1', 'TRL', 'trail', 'o', 0, 0), ('p2', 'DOC', 'docs', 'o', 0, 0);
    insert into activity_event (id, seq, actor_id, subject_type, subject_id, project_id, action, payload, created_at) values
      ('e1', 1, 'b1', 'project', 'p1', 'p1', 'project.created', '{}', 5),
      ('e2', 2, 'b1', 'project', 'p1', 'p1', 'project.updated', '{}', 6);
  `);
  migrate(db, through(11));
  return () => db.$client.close();
});

const subscribe = (id: string, actor = "b1", url = `https://x.test/${id}`) =>
  db.$client
    .prepare(
      "insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values (?, ?, ?, 'sealed', 1, 1)",
    )
    .run(id, actor, url);
const deliver = (id: string, sub: string, event: string, extra = "") =>
  db.$client
    .prepare(
      `insert into webhook_delivery (id, subscription_id, event_id, seq, type, next_attempt_at, created_at${extra ? ", " : ""}${extra.split("=")[0]}) values (?, ?, ?, 1, 'trail.created', 0, 0${extra ? ", " : ""}${extra ? extra.split("=")[1] : ""})`,
    )
    .run(id, sub, event);

test("the history before 0011 is untouched and the foreign keys hold", () => {
  expect(rows(db, "select id from actor order by id")).toHaveLength(3);
  expect(rows(db, "select id from activity_event order by seq")).toEqual([
    { id: "e1" },
    { id: "e2" },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

const webhookTables = [
  "webhook_subscription",
  "webhook_subscription_project",
  "webhook_delivery",
];

test("the three webhook tables are strict", () => {
  for (const table of webhookTables) {
    expect(
      rows(db, "select strict from pragma_table_list where name = ?", table),
    ).toEqual([{ strict: 1 }]);
  }
});

// its own database: the shared one has rows from the other tests by the time this runs
test("the three webhook tables start empty", () => {
  const fresh = openDatabase(join(dir, "empty.db"));
  try {
    migrate(fresh, through(11));
    for (const table of webhookTables) {
      expect(rows(fresh, `select count(*) as n from ${table}`), table).toEqual([
        { n: 0 },
      ]);
    }
  } finally {
    fresh.$client.close();
  }
});

test("a subscription starts unpaused with no failures, and a delivery starts pending with no attempts", () => {
  subscribe("s-defaults");
  deliver("d-defaults", "s-defaults", "e1");
  expect(
    rows(
      db,
      "select paused_at, consecutive_failures, last_success_at, last_error from webhook_subscription where id = 's-defaults'",
    ),
  ).toEqual([
    {
      paused_at: null,
      consecutive_failures: 0,
      last_success_at: null,
      last_error: null,
    },
  ]);
  expect(
    rows(
      db,
      "select status, attempts, body, delivered_at from webhook_delivery where id = 'd-defaults'",
    ),
  ).toEqual([
    { status: "pending", attempts: 0, body: null, delivered_at: null },
  ]);
});

test("a bot has one subscription per URL, and a subscription one delivery per event", () => {
  subscribe("s-a", "b1", "https://x.test/same");
  expect(errorCode(() => subscribe("s-b", "b1", "https://x.test/same"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  // another bot may use the same URL
  expect(() => subscribe("s-c", "b2", "https://x.test/same")).not.toThrow();
  deliver("d-1", "s-a", "e1");
  expect(errorCode(() => deliver("d-2", "s-a", "e1"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expect(() => deliver("d-3", "s-a", "e2")).not.toThrow();
});

test("the checks refuse an empty URL, a bad status and negative counts", () => {
  expect(errorCode(() => subscribe("s-empty", "b1", ""))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  subscribe("s-checks");
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "update webhook_subscription set consecutive_failures = -1 where id = 's-checks'",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
  deliver("d-checks", "s-checks", "e1");
  for (const set of ["status = 'sent'", "attempts = -1"]) {
    expect(
      errorCode(() =>
        db.$client
          .prepare(`update webhook_delivery set ${set} where id = 'd-checks'`)
          .run(),
      ),
      set,
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  }
});

test("the foreign keys hold: no subscription for a missing bot, no delivery for a missing event", () => {
  expect(errorCode(() => subscribe("s-ghost", "nobody"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  subscribe("s-fk");
  expect(errorCode(() => deliver("d-ghost", "s-fk", "no-event"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  // history can't lose the event a delivery points at, or the bot that owns a subscription
  deliver("d-fk", "s-fk", "e1");
  expect(
    errorCode(() =>
      db.$client.prepare("delete from activity_event where id = 'e1'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  expect(
    errorCode(() =>
      db.$client.prepare("delete from actor where id = 'b1'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("deleting a subscription takes its projects and deliveries with it", () => {
  subscribe("s-gone");
  db.$client
    .prepare(
      "insert into webhook_subscription_project (subscription_id, project_id) values ('s-gone', 'p1'), ('s-gone', 'p2')",
    )
    .run();
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "insert into webhook_subscription_project (subscription_id, project_id) values ('s-gone', 'p1')",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
  deliver("d-gone", "s-gone", "e2");
  db.$client
    .prepare("delete from webhook_subscription where id = 's-gone'")
    .run();
  expect(
    rows(
      db,
      "select * from webhook_subscription_project where subscription_id = 's-gone'",
    ),
  ).toEqual([]);
  expect(
    rows(db, "select * from webhook_delivery where id = 'd-gone'"),
  ).toEqual([]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("a project that has subscriptions can't be deleted", () => {
  subscribe("s-proj");
  db.$client
    .prepare(
      "insert into webhook_subscription_project (subscription_id, project_id) values ('s-proj', 'p2')",
    )
    .run();
  expect(
    errorCode(() =>
      db.$client.prepare("delete from project where id = 'p2'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("the indexes are there: pending deliveries by subscription and order, subscriptions by project", () => {
  const indexes = (table: string) =>
    rows(db, 'select name, "partial" from pragma_index_list(?)', table).map(
      (r) => (r as { name: string }).name,
    );
  expect(indexes("webhook_delivery")).toEqual(
    expect.arrayContaining([
      "webhook_delivery_pending_idx",
      "webhook_delivery_subscription_event_unique",
    ]),
  );
  expect(indexes("webhook_subscription_project")).toContain(
    "webhook_subscription_project_project_idx",
  );
  const [pending] = rows(
    db,
    "select \"partial\" as p from pragma_index_list('webhook_delivery') where name = 'webhook_delivery_pending_idx'",
  ) as { p: number }[];
  expect(pending?.p).toBe(1);
});
