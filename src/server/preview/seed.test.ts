import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { accessOf } from "../auth/identity.js";
import { PREVIEW_PERSON } from "../auth/preview.js";
import { type Db, migrate, openDatabase } from "../db/client.js";
import { seedPreview } from "./seed.js";

const dir = mkdtempSync(join(tmpdir(), "trail-preview-seed-"));
const opened: Db[] = [];
afterAll(() => {
  for (const db of opened) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const OWNER_LOGIN = "preview-owner";

/** A migrated database of its own, empty. */
function freshDb(): Db {
  const db = openDatabase(join(dir, `trail-${opened.length}.db`));
  migrate(db);
  opened.push(db);
  return db;
}

test("the preview person is the owner once an empty database is seeded", () => {
  const db = freshDb();
  seedPreview(db, { ownerLogin: OWNER_LOGIN });
  const access = accessOf(db, PREVIEW_PERSON.githubId, OWNER_LOGIN);
  expect(access?.isOwner).toBe(true);
  expect(access?.actor.githubLogin).toBe(OWNER_LOGIN);
});

/** Every row of every table trail keeps, to compare a database before and after. */
function snapshot(db: Db): Record<string, unknown[]> {
  const tables = db.$client
    .prepare(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db.$client.prepare(`select * from "${name}" order by rowid`).all(),
    ]),
  );
}

test("a second seed changes nothing, and an edit made after the first survives it", () => {
  const db = freshDb();
  expect(seedPreview(db, { ownerLogin: OWNER_LOGIN })).toBe(true);
  db.$client
    .prepare(
      "update issue set title = 'Edited in the preview' where number = 1 and product_id = (select id from product where key = 'HBR')",
    )
    .run();
  const before = snapshot(db);

  expect(seedPreview(db, { ownerLogin: OWNER_LOGIN })).toBe(false);

  expect(snapshot(db)).toEqual(before);
  expect(
    db.$client
      .prepare(
        "select count(*) as n from issue where title = 'Edited in the preview'",
      )
      .get(),
  ).toEqual({ n: 1 });
});

test("a database that already has a product is left untouched", () => {
  const db = freshDb();
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values ('a1', 'bot', 'Pip', 0);
    insert into product (id, key, name, created_by, created_at, updated_at) values ('p1', 'PIP', 'Pip''s', 'a1', 0, 0);
  `);
  const before = snapshot(db);

  expect(seedPreview(db, { ownerLogin: OWNER_LOGIN })).toBe(false);

  expect(snapshot(db)).toEqual(before);
});

/** How many rows `from` (a table, with any joins and where) gives, by plain SQL so the test reads the file as it is. */
const count = (db: Db, from: string): number =>
  (
    db.$client.prepare(`select count(*) as n from ${from}`).get() as {
      n: number;
    }
  ).n;

test("an empty database gets every kind of record a screen shows", () => {
  const db = freshDb();
  seedPreview(db, { ownerLogin: OWNER_LOGIN });

  const owned = db.$client
    .prepare(
      `select p.kind, a.kind as owner from product p join actor a on a.id = p.owner_id order by p.kind`,
    )
    .all();
  expect(owned).toEqual([
    { kind: "product", owner: "bot" },
    { kind: "product", owner: "bot" },
    { kind: "team", owner: "bot" },
  ]);
  expect(count(db, "product where owner_id is null")).toBe(0);

  const byTypeAndStatus = new Set(
    (
      db.$client.prepare("select distinct type, status from issue").all() as {
        type: string;
        status: string;
      }[]
    ).map((r) => `${r.type}:${r.status}`),
  );
  for (const kind of [
    "todo:open",
    "issue:triage",
    "issue:open",
    "todo:done",
    "issue:canceled",
    "note:current",
  ]) {
    expect(byTypeAndStatus).toContain(kind);
  }
  expect(count(db, "note_about")).toBeGreaterThan(0);

  // one project drawing from both products, with status updates
  expect(
    db.$client
      .prepare(
        `select count(*) as n from project_product pp join product p on p.id = pp.product_id where p.kind = 'product' group by pp.project_id`,
      )
      .all(),
  ).toEqual([{ n: 2 }]);
  expect(count(db, "project_item")).toBeGreaterThan(0);
  expect(count(db, "project_status_update")).toBeGreaterThanOrEqual(2);

  expect(
    count(
      db,
      "comment c join actor a on a.id = c.author_id where a.kind = 'bot'",
    ),
  ).toBeGreaterThan(0);
  expect(count(db, "actor where kind = 'bot' and handler_id is not null")).toBe(
    1,
  );
  expect(
    count(
      db,
      `issue i join actor a on a.id = i.filed_for_id where a.github_id = ${PREVIEW_PERSON.githubId} and i.type = 'issue'`,
    ),
  ).toBeGreaterThan(0);
  // items in the team, so the team page has work to show
  expect(
    count(
      db,
      "issue i join product p on p.id = i.product_id where p.kind = 'team'",
    ),
  ).toBeGreaterThan(0);
});

test("a seed that fails part-way leaves the database empty, to seed on the next boot", () => {
  const db = freshDb();
  // an invite alone leaves the database empty as the seed counts it, and the
  // seed's own invite of this address collides with it after most writes
  db.$client.pragma("foreign_keys = OFF");
  db.$client
    .prepare(
      "insert into invite (email, invited_by, created_at) values ('rowan@example.test', 'gone', 0)",
    )
    .run();
  db.$client.pragma("foreign_keys = ON");

  expect(() => seedPreview(db, { ownerLogin: OWNER_LOGIN })).toThrow(/UNIQUE/);

  expect(count(db, "actor")).toBe(0);
  expect(count(db, "product")).toBe(0);
  expect(count(db, "issue")).toBe(0);
  expect(count(db, "activity_event")).toBe(0);
});

test("the seed logs nothing and returns no bot key", () => {
  const db = freshDb();
  const logged: unknown[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (level) =>
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args);
      }),
  );
  let result: unknown;
  try {
    result = seedPreview(db, { ownerLogin: OWNER_LOGIN });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  expect(logged).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/trail_/);
  // each bot has a key, stored only as its hash
  expect(count(db, "api_key")).toBe(count(db, "actor where kind = 'bot'"));
  expect(count(db, "api_key where hash like 'trail_%'")).toBe(0);
});
