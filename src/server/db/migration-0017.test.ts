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
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0017-"));
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

const scope = (apiKeyId: string, projectId: string) => () =>
  db.$client
    .prepare(
      "insert into api_key_project (api_key_id, project_id) values (?, ?)",
    )
    .run(apiKeyId, projectId);

let db: Db;
/** the join tables' row counts straight after the migration, before any test writes */
let migrated: unknown[];

// a database as it stood at 0016: a bot with an unrestricted key and a product-scoped one, and a project
beforeAll(() => {
  db = openDatabase(join(dir, "keys.db"));
  migrate(db, through(16));
  const hash = "0".repeat(64);
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('alpha', 'bot', 'alpha', 0);
    insert into product (id, key, name, created_by, created_at, updated_at) values ('p-atl', 'ATL', 'atlas', 'alpha', 0, 0);
    insert into project (id, slug, name, lead_id, created_by, created_at, updated_at) values
      ('pj-recon', 'recon', 'recon', 'alpha', 'alpha', 0, 0),
      ('pj-other', 'other', 'other', 'alpha', 'alpha', 0, 0);
    insert into api_key (id, actor_id, prefix, hash, created_at) values
      ('k-open', 'alpha', 'open', '${hash}', 0),
      ('k-atl', 'alpha', 'atl', '${hash}', 0);
    insert into api_key_product (api_key_id, product_id) values ('k-atl', 'p-atl');
    insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values
      ('s-atl', 'alpha', 'https://x.test/a', 'sealed', 1, 1);
    insert into webhook_subscription_product (subscription_id, product_id) values ('s-atl', 'p-atl');
  `);
  migrate(db, through(17));
  migrated = rows(
    db,
    "select (select count(*) from api_key_project) keys, (select count(*) from webhook_subscription_project) subs",
  );
  return () => db.$client.close();
});

// each test starts with no project rows, so none depends on another having run
beforeEach(() => {
  db.$client.exec(
    "delete from api_key_project; delete from webhook_subscription_project;",
  );
});

const HASH = "0".repeat(64);
const mintKey = (id: string) =>
  db.$client.exec(
    `insert into api_key (id, actor_id, prefix, hash, created_at) values ('${id}', 'alpha', '${id}', '${HASH}', 0)`,
  );
const makeSubscription = (id: string) =>
  db.$client.exec(
    `insert into webhook_subscription (id, actor_id, url, secret_cipher, created_at, updated_at) values ('${id}', 'alpha', 'https://x.test/${id}', 'sealed', 1, 1)`,
  );

test("both tables are STRICT, and existing keys and subscriptions keep their scope with no project rows", () => {
  expect(
    rows(
      db,
      "select name, strict from pragma_table_list where name in ('api_key_project', 'webhook_subscription_project') order by name",
    ),
  ).toEqual([
    { name: "api_key_project", strict: 1 },
    { name: "webhook_subscription_project", strict: 1 },
  ]);
  expect(migrated).toEqual([{ keys: 0, subs: 0 }]);
  expect(
    rows(db, "select api_key_id, product_id from api_key_product"),
  ).toEqual([{ api_key_id: "k-atl", product_id: "p-atl" }]);
  expect(
    rows(
      db,
      "select subscription_id, product_id from webhook_subscription_product",
    ),
  ).toEqual([{ subscription_id: "s-atl", product_id: "p-atl" }]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("a key names a project once, and only a key and project that exist", () => {
  expect(errorCode(scope("k-open", "pj-recon"))).toBe("no error");
  expect(errorCode(scope("k-open", "pj-recon"))).toBe(
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );
  expect(errorCode(scope("k-open", "missing"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(scope("missing", "pj-recon"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
});

test("deleting a key takes its project rows with it", () => {
  mintKey("k-gone-2");
  scope("k-gone-2", "pj-other")();
  db.$client.exec("delete from api_key where id = 'k-gone-2'");
  expect(
    rows(
      db,
      "select count(*) n from api_key_project where api_key_id = 'k-gone-2'",
    ),
  ).toEqual([{ n: 0 }]);
  expect(
    rows(db, "select count(*) n from project where id = 'pj-other'"),
  ).toEqual([{ n: 1 }]);
});

test("a project a key names can't be deleted, so the key's scope never quietly changes", () => {
  scope("k-atl", "pj-other")();
  expect(
    errorCode(() =>
      db.$client.prepare("delete from project where id = 'pj-other'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  expect(
    rows(
      db,
      "select project_id from api_key_project where api_key_id = 'k-atl'",
    ),
  ).toEqual([{ project_id: "pj-other" }]);
});

const follow = (subscriptionId: string, projectId: string) => () =>
  db.$client
    .prepare(
      "insert into webhook_subscription_project (subscription_id, project_id) values (?, ?)",
    )
    .run(subscriptionId, projectId);

test("a subscription follows a project once, and only a subscription and project that exist", () => {
  expect(errorCode(follow("s-atl", "pj-recon"))).toBe("no error");
  expect(errorCode(follow("s-atl", "pj-recon"))).toBe(
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );
  expect(errorCode(follow("s-atl", "missing"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(follow("missing", "pj-recon"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
});

test("deleting a subscription takes its project rows with it; a followed project can't be deleted", () => {
  makeSubscription("s-gone-2");
  follow("s-gone-2", "pj-recon")();
  db.$client.exec("delete from webhook_subscription where id = 's-gone-2'");
  expect(
    rows(
      db,
      "select count(*) n from webhook_subscription_project where subscription_id = 's-gone-2'",
    ),
  ).toEqual([{ n: 0 }]);
  follow("s-atl", "pj-other")();
  expect(
    errorCode(() =>
      db.$client.prepare("delete from project where id = 'pj-other'").run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

const planOf = (sql: string, ...params: unknown[]) =>
  (
    rows(db, `explain query plan ${sql}`, ...params) as { detail: string }[]
  ).map((r) => r.detail);

test.each([
  [
    "which keys name a project",
    "select api_key_id from api_key_project where project_id = ?",
    "SEARCH api_key_project USING COVERING INDEX api_key_project_project_key_idx (project_id=?)",
  ],
  [
    "which subscriptions follow an event's project",
    "select subscription_id from webhook_subscription_project where project_id = ?",
    "SEARCH webhook_subscription_project USING COVERING INDEX webhook_subscription_project_project_idx (project_id=?)",
  ],
])("%s reads the project index, with no table scan", (_, sql, step) => {
  expect(planOf(sql, "pj-recon")).toEqual([step]);
});
