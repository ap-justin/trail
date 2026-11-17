import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";

const shipped = fileURLToPath(new URL("./migrations", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "trail-0019-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations up to `last`
function through(last: number): string {
  const folder = join(dir, `migrations-${last}`);
  cpSync(shipped, folder, { recursive: true });
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

const recordedKeys = (db: Db) =>
  rows(db, "select id, api_key_id from webhook_subscription order by id");

let db: Db;

// a database as it stood at 0018: webhooks made before keys were recorded, of bots
// with one live key, two, only a revoked one, and a revoked and a live one; and one
// webhook whose key was recorded
beforeAll(() => {
  db = openDatabase(join(dir, "webhooks.db"));
  migrate(db, through(18));
  const hash = "0".repeat(64);
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values
      ('one', 'bot', 'one', 0), ('two', 'bot', 'two', 0), ('gone', 'bot', 'gone', 0),
      ('swap', 'bot', 'swap', 0), ('kept', 'bot', 'kept', 0);
    insert into api_key (id, actor_id, prefix, hash, created_at, revoked_at) values
      ('k-one', 'one', 'one00000', '${hash}', 0, null),
      ('k-two-a', 'two', 'two0000a', '${hash}', 0, null),
      ('k-two-b', 'two', 'two0000b', '${hash}', 1, null),
      ('k-gone', 'gone', 'gone0000', '${hash}', 0, 5),
      ('k-swap-old', 'swap', 'swap000o', '${hash}', 0, 5),
      ('k-swap-new', 'swap', 'swap000n', '${hash}', 1, null),
      ('k-kept-a', 'kept', 'kept000a', '${hash}', 0, null),
      ('k-kept-b', 'kept', 'kept000b', '${hash}', 1, null);
    insert into webhook_subscription (id, actor_id, url, kind, secret_cipher, created_at, updated_at, api_key_id) values
      ('s-one', 'one', 'https://x.test/one', 'activity', 'sealed', 1, 1, null),
      ('s-one-inbox', 'one', 'https://x.test/one-inbox', 'inbox', 'sealed', 1, 1, null),
      ('s-two', 'two', 'https://x.test/two', 'activity', 'sealed', 1, 1, null),
      ('s-gone', 'gone', 'https://x.test/gone', 'activity', 'sealed', 1, 1, null),
      ('s-swap', 'swap', 'https://x.test/swap', 'inbox', 'sealed', 1, 1, null),
      ('s-kept', 'kept', 'https://x.test/kept', 'activity', 'sealed', 1, 7, 'k-kept-b');
  `);
  migrate(db, through(19));
  return () => db.$client.close();
});

const backfilled = [
  { id: "s-gone", api_key_id: null },
  { id: "s-kept", api_key_id: "k-kept-b" },
  { id: "s-one", api_key_id: "k-one" },
  { id: "s-one-inbox", api_key_id: "k-one" },
  { id: "s-swap", api_key_id: "k-swap-new" },
  { id: "s-two", api_key_id: null },
];

test("a webhook with no recorded key takes its bot's key when the bot has exactly one live key, of either kind", () => {
  expect(recordedKeys(db)).toEqual(backfilled);
});

test("the backfill changes nothing else on a webhook and leaves the table strict and consistent", () => {
  expect(
    rows(
      db,
      "select id, url, updated_at from webhook_subscription where id in ('s-one', 's-kept') order by id",
    ),
  ).toEqual([
    { id: "s-kept", url: "https://x.test/kept", updated_at: 7 },
    { id: "s-one", url: "https://x.test/one", updated_at: 1 },
  ]);
  expect(
    rows(
      db,
      "select strict from pragma_table_list where name = 'webhook_subscription'",
    ),
  ).toEqual([{ strict: 1 }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("running the backfill again changes nothing", () => {
  const file = readdirSync(shipped).find((f) => f.startsWith("0019_"));
  expect(file).toBeDefined();
  db.$client.exec(readFileSync(join(shipped, file ?? ""), "utf8"));
  expect(recordedKeys(db)).toEqual(backfilled);
});
