import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { migrate, openDatabase } from "./client.js";
import { activityEvent, actor, apiKey, issue, project } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "trail-schema-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const sqlite = db.$client;
const errorCode = (write: () => unknown) => {
  try {
    write();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

const bot = db
  .insert(actor)
  .values({ kind: "bot", displayName: "builder" })
  .returning()
  .get();
const human = db
  .insert(actor)
  .values({ kind: "human", displayName: "Justin", githubId: 89639563 })
  .returning()
  .get();
const proj = db
  .insert(project)
  .values({ name: "trail", createdBy: bot.id })
  .returning()
  .get();

test("a valid issue round-trips with its defaults", () => {
  const created = db
    .insert(issue)
    .values({ projectId: proj.id, title: "Ship schema", createdBy: bot.id })
    .returning()
    .get();
  const read = db.select().from(issue).where(eq(issue.id, created.id)).get();
  expect(read).toMatchObject({
    status: "open",
    description: "",
    assigneeId: null,
  });
  expect(read?.createdAt).toBeInstanceOf(Date);
  expect(read?.createdAt.getTime()).toBe(created.createdAt.getTime());
});

test("an issue in a missing project is rejected", () => {
  expect(
    errorCode(() =>
      db
        .insert(issue)
        .values({ projectId: "nope", title: "Orphan", createdBy: bot.id })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("an issue status outside the enum is rejected", () => {
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into issue (id, project_id, title, status, created_by, created_at, updated_at) values ('i1', ?, 't', 'closed', ?, 0, 0)",
        )
        .run(proj.id, bot.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("an actor kind outside the enum is rejected", () => {
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into actor (id, kind, display_name, created_at) values ('a1', 'robot', 'r', 0)",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a bot cannot carry a GitHub id", () => {
  expect(
    errorCode(() =>
      db
        .insert(actor)
        .values({ kind: "bot", displayName: "b", githubId: 1 })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("an api key belongs to a bot, never a human", () => {
  const key = { prefix: "trl_abc", hash: "a".repeat(64) };
  db.insert(apiKey)
    .values({ actorId: bot.id, ...key })
    .run();
  expect(
    errorCode(() =>
      db
        .insert(apiKey)
        .values({ actorId: human.id, prefix: "trl_def", hash: key.hash })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("an activity payload must be valid JSON", () => {
  const event = {
    actorId: bot.id,
    subjectType: "project" as const,
    subjectId: proj.id,
  };
  const stored = db
    .insert(activityEvent)
    .values({ ...event, action: "created", payload: { name: "trail" } })
    .returning()
    .get();
  expect(stored.payload).toEqual({ name: "trail" });
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into activity_event (id, actor_id, subject_type, subject_id, action, payload, created_at) values ('e1', ?, 'project', ?, 'created', '{oops', 0)",
        )
        .run(bot.id, proj.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a timestamp column refuses text", () => {
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into actor (id, kind, display_name, created_at) values ('a2', 'bot', 'b', 'yesterday')",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_DATATYPE");
});

// the shape service listIssues sends for a project with no status filter, first page and later
test.each([
  ["first page", eq(issue.projectId, proj.id)],
  [
    "after a cursor",
    and(
      eq(issue.projectId, proj.id),
      or(
        lt(issue.createdAt, new Date(1)),
        and(eq(issue.createdAt, new Date(1)), lt(issue.id, "x")),
      ),
    ),
  ],
])(
  "a project's issue list, %s, is read in index order with no sort",
  (_, where) => {
    const query = db
      .select()
      .from(issue)
      .where(where)
      .orderBy(desc(issue.createdAt), desc(issue.id))
      .limit(51)
      .toSQL();
    const plan = sqlite
      .prepare(`explain query plan ${query.sql}`)
      .all(...query.params)
      .map((row) => (row as { detail: string }).detail)
      .join(" | ");
    expect(plan).toContain("issue_project_created_idx");
    expect(plan).not.toContain("TEMP B-TREE");
  },
);
