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

const dir = mkdtempSync(join(tmpdir(), "trail-0012-"));
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
  db = openDatabase(join(dir, "invites.db"));
  migrate(db, through(11));
  db.$client.exec(`
    insert into actor (id, kind, display_name, github_id, github_login, is_owner, created_at) values
      ('o', 'human', 'Olive', 1, 'olive', 1, 0), ('h2', 'human', 'Bob', 42, 'bob', 0, 0);
    insert into project (id, key, name, created_by, created_at, updated_at) values
      ('p1', 'TRL', 'trail', 'o', 0, 0), ('p2', 'DOC', 'docs', 'o', 0, 0);
    insert into invite (username, invited_by, github_id, created_at) values
      ('ada', 'o', null, 10), ('bob', 'o', 42, 20);
    insert into project_member (username, project_id, created_at) values
      ('ada', 'p1', 11), ('bob', 'p1', 21), ('bob', 'p2', 22);
    insert into user (id, name, email, email_verified, created_at, updated_at, github_id, github_login) values
      ('u1', 'Bob', '42@users.noreply.github.com', 1, 0, 0, 42, 'bob');
    insert into account (id, account_id, provider_id, user_id, created_at, updated_at) values
      ('a1', '42', 'github', 'u1', 0, 0);
    insert into session (id, expires_at, token, created_at, updated_at, user_id) values
      ('s1', 9999999999999, 'tok', 0, 0, 'u1');
  `);
  migrate(db, through(12));
  return () => db.$client.close();
});

const insertInvite = (invite: {
  username?: string | null;
  email?: string | null;
  githubId?: number | null;
}) =>
  db.$client
    .prepare(
      "insert into invite (username, email, invited_by, github_id, created_at) values (?, ?, 'o', ?, 0)",
    )
    .run(
      invite.username ?? null,
      invite.email ?? null,
      invite.githubId ?? null,
    );

test("every invite from before 0012 is a GitHub invite, its binding kept", () => {
  expect(
    rows(
      db,
      "select username, email, invited_by, github_id, created_at from invite order by created_at",
    ),
  ).toEqual([
    {
      username: "ada",
      email: null,
      invited_by: "o",
      github_id: null,
      created_at: 10,
    },
    {
      username: "bob",
      email: null,
      invited_by: "o",
      github_id: 42,
      created_at: 20,
    },
  ]);
});

test("every project_member row survives, under the invite it belonged to", () => {
  expect(
    rows(
      db,
      "select i.username, m.project_id, m.created_at from project_member m join invite i on i.id = m.invite_id order by m.created_at",
    ),
  ).toEqual([
    { username: "ada", project_id: "p1", created_at: 11 },
    { username: "bob", project_id: "p1", created_at: 21 },
    { username: "bob", project_id: "p2", created_at: 22 },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("actors are untouched and carry no email", () => {
  expect(
    rows(
      db,
      "select id, github_id, github_login, email from actor order by id",
    ),
  ).toEqual([
    { id: "h2", github_id: 42, github_login: "bob", email: null },
    { id: "o", github_id: 1, github_login: "olive", email: null },
  ]);
});

test("a GitHub sign-in's user, account and session survive, signed in as before", () => {
  expect(
    rows(
      db,
      "select u.id, u.github_id, u.github_login, a.provider_id, s.token from user u join account a on a.user_id = u.id join session s on s.user_id = u.id",
    ),
  ).toEqual([
    {
      id: "u1",
      github_id: 42,
      github_login: "bob",
      provider_id: "github",
      token: "tok",
    },
  ]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});

test("a user signed in by email has no GitHub account; a GitHub one has both its id and login", () => {
  const user =
    (id: string, githubId: number | null, login: string | null) => () =>
      db.$client
        .prepare(
          "insert into user (id, name, email, email_verified, created_at, updated_at, github_id, github_login) values (?, '', ?, 1, 0, 0, ?, ?)",
        )
        .run(id, `${id}@x.io`, githubId, login);
  expect(errorCode(user("u2", null, null))).toBe("no error");
  expect(errorCode(user("u3", 77, null))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(user("u4", null, "carol"))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(user("u5", 42, "bob2"))).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

test("a bound invite's GitHub id still can't be rewritten", () => {
  expect(
    errorCode(() =>
      db.$client
        .prepare("update invite set github_id = 43 where username = 'bob'")
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_TRIGGER");
});

test("an invite holds exactly one of a GitHub username or an email address", () => {
  expect(
    errorCode(() => insertInvite({ username: "both", email: "both@x.io" })),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(() => insertInvite({}))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(() => insertInvite({ email: "one@x.io" }))).toBe("no error");
});

test("an email is invited once, and is stored trimmed and lowercased", () => {
  insertInvite({ email: "dana@example.com" });
  expect(errorCode(() => insertInvite({ email: "dana@example.com" }))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  // a differently-cased or padded spelling never reaches the row, so it can't dodge the unique index
  expect(errorCode(() => insertInvite({ email: "Dana@example.com" }))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  expect(errorCode(() => insertInvite({ email: " dana@example.com" }))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
});

test.each([
  "dana",
  "dana@",
  "@example.com",
  "dana@example",
  "dana@@example.com",
  "da@na@example.com",
  "da na@example.com",
  `${"a".repeat(250)}@x.io`,
])("an email %j is rejected", (email) => {
  expect(errorCode(() => insertInvite({ email }))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
});

test("an email invite never binds a GitHub id", () => {
  expect(
    errorCode(() => insertInvite({ email: "gh@x.io", githubId: 77 })),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a project_member row references an invite of either kind, and goes with it", () => {
  // invite.id is the rowid
  const id = Number(insertInvite({ email: "member@x.io" }).lastInsertRowid);
  const member = (inviteId: number) => () =>
    db.$client
      .prepare(
        "insert into project_member (invite_id, project_id, created_at) values (?, 'p2', 0)",
      )
      .run(inviteId);
  expect(errorCode(member(id))).toBe("no error");
  expect(errorCode(member(id))).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
  expect(errorCode(member(99999))).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");

  db.$client.prepare("delete from invite where id = ?").run(id);
  expect(
    rows(db, "select * from project_member where invite_id = ?", id),
  ).toEqual([]);
});

test("a human may carry one trimmed, lowercased email; a bot carries none", () => {
  const withEmail =
    (id: string, email: string, kind = "human") =>
    () =>
      db.$client
        .prepare(
          "insert into actor (id, kind, display_name, email, created_at) values (?, ?, 'p', ?, 0)",
        )
        .run(id, kind, email);
  expect(errorCode(withEmail("e1", "erin@x.io"))).toBe("no error");
  expect(errorCode(withEmail("e2", "erin@x.io"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expect(errorCode(withEmail("e3", "Erin2@x.io"))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  expect(errorCode(withEmail("e4", "bot@x.io", "bot"))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  // an email person signs in by email alone, never also as a GitHub account
  expect(
    errorCode(() =>
      db.$client
        .prepare(
          "insert into actor (id, kind, display_name, email, github_id, created_at) values ('e5', 'human', 'p', 'gh-too@x.io', 5, 0)",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});
