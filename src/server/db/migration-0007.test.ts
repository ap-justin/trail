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

const dir = mkdtempSync(join(tmpdir(), "trail-0007-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations up to `last`; later steps stay out, so their columns never
// reach the rows this file compares
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

const rows = (db: Db, sql: string) => db.$client.prepare(sql).all();

test("a database holding 0006 data keeps every row; no actor is the owner and no invite is bound", () => {
  const db = openDatabase(join(dir, "live.db"));
  migrate(db, through(6));
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, github_login, label, created_at) values
      ('b1', 'bot', 'Tara', null, null, 'agt_1', 0), ('h1', 'human', 'Justin', 89639563, 'justin', null, 0);
    insert into api_key (id, actor_id, actor_kind, prefix, hash, created_at) values
      ('k1', 'b1', 'bot', 'trl_ab', '${"a".repeat(64)}', 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p', 'TRL', 'trail', 'b1', 0, 0);
    insert into issue (id, project_id, number, title, created_by, created_at, updated_at) values
      ('i1', 'p', 1, 'first', 'b1', 1, 1);
    insert into comment (id, issue_id, author_id, body, created_at) values ('c1', 'i1', 'h1', 'hi', 0);
    insert into invite (username, invited_by, created_at) values ('ada', 'h1', 0);
    insert into project_member (username, project_id, created_at) values ('ada', 'p', 0);
    insert into "user" (id, name, email, github_id, github_login) values ('u1', 'Justin', 'j@x', 89639563, 'justin');
    insert into session (id, expires_at, token, updated_at, user_id) values ('s1', 0, 't', 0, 'u1');
    insert into account (id, account_id, provider_id, user_id, updated_at) values ('a1', '89639563', 'github', 'u1', 0);
  `);
  const tables = [
    "actor",
    "api_key",
    "project",
    "issue",
    "comment",
    "invite",
    "project_member",
    '"user"',
    "session",
    "account",
  ];
  const allRows = () =>
    Object.fromEntries(
      tables.map((t) => [t, rows(db, `select * from ${t} order by 1`)]),
    );
  const before = allRows();

  migrate(db, through(7));

  const gained: Record<string, object> = {
    actor: { is_owner: 0 },
    invite: { github_id: null },
  };
  expect(allRows()).toEqual(
    Object.fromEntries(
      Object.entries(before).map(([t, list]) => [
        t,
        (list as object[]).map((r) => ({ ...r, ...gained[t] })),
      ]),
    ),
  );
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
  db.$client.close();
});
