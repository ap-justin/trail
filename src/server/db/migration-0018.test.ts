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

const dir = mkdtempSync(join(tmpdir(), "trail-0018-"));
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

// a database as it stood at 0017: a bot with a key and an activity and an inbox subscription
beforeAll(() => {
  db = openDatabase(join(dir, "webhooks.db"));
  migrate(db, through(17));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('alpha', 'bot', 'alpha', 0);
    insert into api_key (id, actor_id, prefix, hash, created_at) values ('k-alpha', 'alpha', 'alpha', '${"0".repeat(64)}', 0);
    insert into webhook_subscription (id, actor_id, url, kind, secret_cipher, created_at, updated_at) values
      ('s-activity', 'alpha', 'https://x.test/a', 'activity', 'sealed', 1, 1),
      ('s-inbox', 'alpha', 'https://x.test/i', 'inbox', 'sealed', 1, 1);
  `);
  migrate(db, through(18));
  return () => db.$client.close();
});

const setKey = (subscriptionId: string, keyId: string | null) => () =>
  db.$client
    .prepare("update webhook_subscription set api_key_id = ? where id = ?")
    .run(keyId, subscriptionId);

test("existing subscriptions keep every column and have no creating key", () => {
  expect(
    rows(
      db,
      "select id, kind, url, api_key_id from webhook_subscription order by id",
    ),
  ).toEqual([
    {
      id: "s-activity",
      kind: "activity",
      url: "https://x.test/a",
      api_key_id: null,
    },
    { id: "s-inbox", kind: "inbox", url: "https://x.test/i", api_key_id: null },
  ]);
  expect(
    rows(
      db,
      "select strict from pragma_table_list where name = 'webhook_subscription'",
    ),
  ).toEqual([{ strict: 1 }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("the creating key must exist, and stays nullable", () => {
  expect(errorCode(setKey("s-activity", "k-alpha"))).toBe("no error");
  expect(errorCode(setKey("s-activity", "missing"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(setKey("s-activity", null))).toBe("no error");
});

test("a key that created a subscription can't be deleted, so the subscription never quietly loses its check", () => {
  setKey("s-inbox", "k-alpha")();
  expect(
    errorCode(() =>
      db.$client.prepare("delete from api_key where id = 'k-alpha'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  expect(
    rows(
      db,
      "select api_key_id from webhook_subscription where id = 's-inbox'",
    ),
  ).toEqual([{ api_key_id: "k-alpha" }]);
});
