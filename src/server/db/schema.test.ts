import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { migrate, openDatabase } from "./client.js";
import { newId } from "./id.js";
import {
  activityEvent,
  actor,
  apiKey,
  apiKeyProject,
  comment,
  idempotencyKey,
  invite,
  issue,
  issueLabel,
  issueLink,
  label,
  project,
  projectHealths,
  projectMember,
  projectStatusUpdate,
} from "./schema.js";

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

const planOf = (query: { sql: string; params: unknown[] }) =>
  sqlite
    .prepare(`explain query plan ${query.sql}`)
    .all(...query.params)
    .map((row) => (row as { detail: string }).detail)
    .join(" | ");

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
  .values({ key: "TRL", name: "trail", createdBy: bot.id })
  .returning()
  .get();

test("a valid issue round-trips with its defaults", () => {
  const created = db
    .insert(issue)
    .values({
      projectId: proj.id,
      number: 1,
      title: "Ship schema",
      createdBy: bot.id,
    })
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

test.each(["T", "TOOLONGKEY1", "trl", "TR-L", "TRÉ"])(
  "a project key %j is rejected",
  (key) => {
    expect(
      errorCode(() =>
        db.insert(project).values({ key, name: "x", createdBy: bot.id }).run(),
      ),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  },
);

test("a project key is unique", () => {
  expect(
    errorCode(() =>
      db
        .insert(project)
        .values({ key: "TRL", name: "again", createdBy: bot.id })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

test("an issue number is unique within its project and starts at 1", () => {
  const other = db
    .insert(project)
    .values({ key: "OTH2", name: "other", createdBy: bot.id })
    .returning()
    .get();
  const numbered = (projectId: string, number: number) => () =>
    db
      .insert(issue)
      .values({ projectId, number, title: "n", createdBy: bot.id })
      .run();
  numbered(proj.id, 7)();
  numbered(other.id, 7)();
  expect(errorCode(numbered(proj.id, 7))).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(errorCode(numbered(proj.id, 0))).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("an issue in a missing project is rejected", () => {
  expect(
    errorCode(() =>
      db
        .insert(issue)
        .values({
          projectId: "nope",
          number: 1,
          title: "Orphan",
          createdBy: bot.id,
        })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("an issue status outside the enum is rejected", () => {
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into issue (id, project_id, number, title, status, created_by, created_at, updated_at) values ('i1', ?, 99, 't', 'closed', ?, 0, 0)",
        )
        .run(proj.id, bot.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test.each([
  ["open", 1],
  ["in_progress", 1],
  ["done", null],
  ["canceled", null],
] as const)(
  "an issue in status %s with completed_at %j is rejected",
  (status, completedAt) => {
    expect(
      errorCode(() =>
        sqlite
          .prepare(
            "insert into issue (id, project_id, number, title, status, created_by, created_at, updated_at, completed_at) values ('i-c', ?, 98, 't', ?, ?, 0, 0, ?)",
          )
          .run(proj.id, status, bot.id, completedAt),
      ),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  },
);

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
          "insert into activity_event (id, seq, actor_id, subject_type, subject_id, action, payload, created_at) values ('e1', -1, ?, 'project', ?, 'created', '{oops', 0)",
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
    const plan = planOf(
      db
        .select()
        .from(issue)
        .where(where)
        .orderBy(desc(issue.createdAt), desc(issue.id))
        .limit(51)
        .toSQL(),
    );
    expect(plan).toContain("issue_project_created_idx");
    expect(plan).not.toContain("TEMP B-TREE");
  },
);

let nextNumber = 1000;
const newIssue =
  (fields: Partial<typeof issue.$inferInsert> = {}) =>
  () =>
    db
      .insert(issue)
      .values({
        projectId: proj.id,
        number: nextNumber++,
        title: "t",
        createdBy: bot.id,
        ...fields,
      })
      .returning()
      .get();

test("an issue has no estimate and no priority until given one", () => {
  expect(newIssue()()).toMatchObject({
    estimate: null,
    priority: 0,
    completedAt: null,
    externalRef: null,
    sourceAuthor: null,
  });
  expect(newIssue({ estimate: 1.5, priority: 4 })()).toMatchObject({
    estimate: 1.5,
    priority: 4,
  });
});

test.each([{ estimate: -0.5 }, { priority: 5 }, { priority: -1 }])(
  "an issue with %j is rejected",
  (fields) => {
    expect(errorCode(newIssue(fields))).toBe("SQLITE_CONSTRAINT_CHECK");
  },
);

test("an issue's source status is null until given, and at most 200 characters", () => {
  expect(newIssue()().sourceStatus).toBeNull();
  expect(newIssue({ sourceStatus: "In Review" })().sourceStatus).toBe(
    "In Review",
  );
  expect(newIssue({ sourceStatus: "x".repeat(200) })().sourceStatus).toBe(
    "x".repeat(200),
  );
  expect(errorCode(newIssue({ sourceStatus: "x".repeat(201) }))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
});

test("an issue's external ref is unique within its project only", () => {
  const other = db
    .insert(project)
    .values({ key: "REF", name: "refs", createdBy: bot.id })
    .returning()
    .get();
  newIssue({ externalRef: "JUS-1" })();
  newIssue({ externalRef: "JUS-1", projectId: other.id })();
  newIssue()();
  newIssue()();
  expect(errorCode(newIssue({ externalRef: "JUS-1" }))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
});

test("a project's external ref is unique across projects", () => {
  const withRef = (key: string) => () =>
    db
      .insert(project)
      .values({ key, name: "p", createdBy: bot.id, externalRef: "P-JUS-9" })
      .run();
  withRef("EXA")();
  expect(errorCode(withRef("EXB"))).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

test("a comment's external ref is unique within its issue only", () => {
  const first = newIssue()();
  const second = newIssue()();
  const commentOn = (issueId: string) => () =>
    db
      .insert(comment)
      .values({
        issueId,
        authorId: bot.id,
        body: "imported",
        externalRef: "c-1",
        sourceAuthor: "Justin",
      })
      .run();
  commentOn(first.id)();
  commentOn(second.id)();
  expect(errorCode(commentOn(first.id))).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

test("a label name is unique within its project and non-empty", () => {
  const other = db
    .insert(project)
    .values({ key: "LBL", name: "labels", createdBy: bot.id })
    .returning()
    .get();
  const labelIn = (projectId: string, name: string) => () =>
    db.insert(label).values({ projectId, name }).run();
  labelIn(proj.id, "bug")();
  labelIn(other.id, "bug")();
  expect(errorCode(labelIn(proj.id, "bug"))).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(errorCode(labelIn(proj.id, ""))).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a label name collides regardless of ASCII case, within its project only", () => {
  const other = db
    .insert(project)
    .values({ key: "LBC", name: "label case", createdBy: bot.id })
    .returning()
    .get();
  const labelIn = (projectId: string, name: string) => () =>
    db.insert(label).values({ projectId, name }).run();
  labelIn(proj.id, "Foo")();
  labelIn(other.id, "foo")();
  expect(errorCode(labelIn(proj.id, "foo"))).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(
    db
      .select({ name: label.name })
      .from(label)
      .where(eq(label.projectId, proj.id))
      .all()
      .map((l) => l.name),
  ).toContain("Foo");
});

test("an issue takes labels from its own project only, and loses them with the label", () => {
  const other = db
    .insert(project)
    .values({ key: "LBX", name: "elsewhere", createdBy: bot.id })
    .returning()
    .get();
  const labelIn = (projectId: string) =>
    db.insert(label).values({ projectId, name: "feature" }).returning().get();
  const own = labelIn(proj.id);
  const foreign = labelIn(other.id);
  const labeled = newIssue()();

  db.insert(issueLabel)
    .values({ issueId: labeled.id, labelId: own.id, projectId: proj.id })
    .run();
  expect(
    errorCode(() =>
      db
        .insert(issueLabel)
        .values({
          issueId: labeled.id,
          labelId: foreign.id,
          projectId: proj.id,
        })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  expect(
    errorCode(() =>
      db
        .insert(issueLabel)
        .values({
          issueId: labeled.id,
          labelId: foreign.id,
          projectId: other.id,
        })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");

  db.delete(label).where(eq(label.id, own.id)).run();
  expect(
    db
      .select()
      .from(issueLabel)
      .where(eq(issueLabel.issueId, labeled.id))
      .all(),
  ).toEqual([]);
});

test("an issue links a url once", () => {
  const linked = newIssue()();
  const link =
    (url: string, title = "PR #12") =>
    () =>
      db.insert(issueLink).values({ issueId: linked.id, url, title }).run();
  link("https://github.com/x/trail/pull/12")();
  expect(errorCode(link("https://github.com/x/trail/pull/12"))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expect(errorCode(link(""))).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(link("https://example.com", ""))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
});

test("a status update needs a body and a known health", () => {
  const update =
    (fields: Partial<typeof projectStatusUpdate.$inferInsert>) => () =>
      db
        .insert(projectStatusUpdate)
        .values({
          projectId: proj.id,
          authorId: bot.id,
          body: "on schedule",
          health: "on_track",
          ...fields,
        })
        .run();
  for (const health of projectHealths) update({ health })();
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into project_status_update (id, project_id, author_id, body, health, created_at) values ('s1', ?, ?, 'b', 'late', 0)",
        )
        .run(proj.id, bot.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
  expect(errorCode(update({ body: "" }))).toBe("SQLITE_CONSTRAINT_CHECK");
  update({ externalRef: "su-1", sourceAuthor: "Justin" })();
  expect(errorCode(update({ externalRef: "su-1" }))).toBe(
    "SQLITE_CONSTRAINT_UNIQUE",
  );
});

// the shape a newest-first status update list sends
test("a project's status updates are read newest first in index order", () => {
  const query = db
    .select()
    .from(projectStatusUpdate)
    .where(eq(projectStatusUpdate.projectId, proj.id))
    .orderBy(desc(projectStatusUpdate.createdAt), desc(projectStatusUpdate.id))
    .limit(51)
    .toSQL();
  expect(planOf(query)).toContain("project_status_update_project_created_idx");
  expect(planOf(query)).not.toContain("TEMP B-TREE");
});

test("an idempotency key is per actor, and stores the first response", () => {
  const remember =
    (actorId: string, response: unknown = { id: "p1" }) =>
    () =>
      db
        .insert(idempotencyKey)
        .values({
          actorId,
          key: "req-1",
          scope: "project.create",
          requestHash: "a".repeat(64),
          response,
        })
        .run();
  remember(bot.id)();
  remember(human.id)();
  expect(errorCode(remember(bot.id))).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
  expect(
    db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.actorId, bot.id))
      .get(),
  ).toMatchObject({ scope: "project.create", response: { id: "p1" } });
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into idempotency_key (actor_id, key, scope, request_hash, response, created_at) values (?, 'req-2', 'project.create', 'h', '{oops', 0)",
        )
        .run(bot.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a bot name and a bot label are each unique among bots", () => {
  const newActor = (fields: Partial<typeof actor.$inferInsert>) => () =>
    db
      .insert(actor)
      .values({ kind: "bot", displayName: "unique-bot", ...fields })
      .run();
  newActor({ label: "agent-1" })();
  newActor({ kind: "human", displayName: "unique-bot", label: "agent-1" })();
  newActor({ kind: "human", displayName: "unique-bot" })();
  newActor({ displayName: "other-bot" })();
  newActor({ displayName: "third-bot" })();
  expect(errorCode(newActor({}))).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(
    errorCode(newActor({ displayName: "fourth-bot", label: "agent-1" })),
  ).toBe("SQLITE_CONSTRAINT_UNIQUE");
});

const newEvent = (fields: Partial<typeof activityEvent.$inferInsert> = {}) =>
  db
    .insert(activityEvent)
    .values({
      actorId: bot.id,
      subjectType: "project",
      subjectId: proj.id,
      projectId: proj.id,
      action: "project.updated",
      ...fields,
    })
    .returning()
    .get();

test("events take seq in the order they are written, whatever their ids and clock", () => {
  const sameMs = new Date(5_000);
  const written = ["e-z", "e-m", "e-a"].map((id) =>
    newEvent({ id, createdAt: sameMs }),
  );
  const backwardsClock = newEvent({ createdAt: new Date(1) });

  const seqs = [...written, backwardsClock].map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(4);
});

test("a second connection's events continue the same seq", () => {
  const second = openDatabase(sqlite.name);
  const mine = newEvent();
  const theirs = second
    .insert(activityEvent)
    .values({
      actorId: bot.id,
      subjectType: "project",
      subjectId: proj.id,
      action: "project.updated",
    })
    .returning()
    .get();
  const mineAgain = newEvent();
  second.$client.close();

  expect(theirs.seq).toBe(mine.seq + 1);
  expect(mineAgain.seq).toBe(theirs.seq + 1);
});

test("a raw insert that names no seq is refused, not left out of the feed", () => {
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into activity_event (id, actor_id, subject_type, subject_id, action, created_at) values ('e-raw', ?, 'project', ?, 'created', 0)",
        )
        .run(bot.id, proj.id),
    ),
  ).toBe("SQLITE_CONSTRAINT_NOTNULL");
});

test.each(["status_update", "label"] as const)(
  "an event can be about a %s",
  (subjectType) => {
    expect(
      newEvent({ subjectType, action: `${subjectType}.created` }),
    ).toMatchObject({
      subjectType,
    });
  },
);

// the shapes a resumable feed sends: everything, or one project's or actor's, after a seq
test.each([
  ["all events", gt(activityEvent.seq, 3), "activity_event_seq_unique"],
  [
    "one project",
    and(eq(activityEvent.projectId, proj.id), gt(activityEvent.seq, 3)),
    "activity_event_project_seq_idx",
  ],
  [
    "one actor",
    and(eq(activityEvent.actorId, bot.id), gt(activityEvent.seq, 3)),
    "activity_event_actor_seq_idx",
  ],
])("the feed for %s resumes in index order with no sort", (_, where, index) => {
  for (const direction of [asc, desc]) {
    const plan = planOf(
      db
        .select()
        .from(activityEvent)
        .where(where)
        .orderBy(direction(activityEvent.seq))
        .limit(51)
        .toSQL(),
    );
    expect(plan).toContain(index);
    expect(plan).not.toContain("TEMP B-TREE");
  }
});

test("a human carries a lowercased GitHub login, unique among actors; a bot carries none", () => {
  const withLogin =
    (githubLogin: string, kind: "human" | "bot" = "human") =>
    () =>
      db.insert(actor).values({ kind, displayName: "p", githubLogin }).run();
  withLogin("octo-cat9")();
  expect(errorCode(withLogin("octo-cat9"))).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(errorCode(withLogin("tara-bot", "bot"))).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  expect(errorCode(withLogin("a".repeat(39)))).toBe("no error");
});

const malformedLogins = [
  "",
  "Octocat",
  "-octocat",
  "octocat-",
  "octo--cat",
  "octo_cat",
  "octo.cat",
  "a".repeat(40),
];

test.each(malformedLogins)("a GitHub login %j is rejected", (githubLogin) => {
  expect(
    errorCode(() =>
      db
        .insert(actor)
        .values({ kind: "human", displayName: "p", githubLogin })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test.each(malformedLogins)("an invite for %j is rejected", (username) => {
  expect(
    errorCode(() =>
      db.insert(invite).values({ username, invitedBy: human.id }).run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a username is invited once, and its projects must exist", () => {
  const once = db
    .insert(invite)
    .values({ username: "once", invitedBy: human.id })
    .returning()
    .get();
  expect(
    errorCode(() =>
      db.insert(invite).values({ username: "once", invitedBy: human.id }).run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  const member = (inviteId: number, projectId: string) => () =>
    db.insert(projectMember).values({ inviteId, projectId }).run();
  member(once.id, proj.id)();
  expect(errorCode(member(once.id, proj.id))).toBe(
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );
  expect(errorCode(member(once.id + 1000, proj.id))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expect(errorCode(member(once.id, "nope"))).toBe(
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
});

test("an invite binds one GitHub id, never held by another invite", () => {
  const pending = db
    .insert(invite)
    .values({ username: "binds", invitedBy: human.id })
    .returning()
    .get();
  expect(pending.githubId).toBeNull();
  const bind = (username: string, githubId: number) => () =>
    db
      .update(invite)
      .set({ githubId })
      .where(eq(invite.username, username))
      .run();
  bind("binds", 4001)();
  db.insert(invite)
    .values({ username: "binds-too", invitedBy: human.id })
    .run();
  expect(errorCode(bind("binds-too", 4001))).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(errorCode(bind("binds-too", 4002))).toBe("no error");
});

test("an invite's GitHub id, once bound, is never rewritten or cleared", () => {
  db.insert(invite)
    .values({ username: "pinned", invitedBy: human.id, githubId: 4101 })
    .run();
  const rebind = (githubId: number | null) => () =>
    db
      .update(invite)
      .set({ githubId })
      .where(eq(invite.username, "pinned"))
      .run();
  expect(errorCode(rebind(4102))).toBe("SQLITE_CONSTRAINT_TRIGGER");
  expect(errorCode(rebind(null))).toBe("SQLITE_CONSTRAINT_TRIGGER");
  expect(errorCode(rebind(4101))).toBe("no error");
  expect(
    db.select().from(invite).where(eq(invite.username, "pinned")).get()
      ?.githubId,
  ).toBe(4101);
});

test("one human at most is the owner, and a bot never is", () => {
  const person = (isOwner: boolean, kind: "human" | "bot" = "human") =>
    db
      .insert(actor)
      .values({ kind, displayName: `owner-${newId()}`, isOwner })
      .returning();
  expect(
    db
      .insert(actor)
      .values({ kind: "human", displayName: "p" })
      .returning()
      .get().isOwner,
  ).toBe(false);
  expect(errorCode(() => person(true, "bot").get())).toBe(
    "SQLITE_CONSTRAINT_CHECK",
  );
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into actor (id, kind, display_name, is_owner, created_at) values ('o2', 'human', 'p', 2, 0)",
        )
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
  const owner = person(true).get();
  expect(owner.isOwner).toBe(true);
  expect(errorCode(() => person(true).get())).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(errorCode(() => person(false).get())).toBe("no error");
});

test("removing an invite drops its projects and keeps the person's actor and writing", () => {
  const other = db
    .insert(project)
    .values({ key: "MBR", name: "members", createdBy: bot.id })
    .returning()
    .get();
  const leaver = db
    .insert(invite)
    .values({ username: "leaver", invitedBy: human.id })
    .returning()
    .get();
  db.insert(projectMember)
    .values([
      { inviteId: leaver.id, projectId: proj.id },
      { inviteId: leaver.id, projectId: other.id },
    ])
    .run();
  const person = db
    .insert(actor)
    .values({ kind: "human", displayName: "Leaver", githubLogin: "leaver" })
    .returning()
    .get();
  const filed = newIssue({ createdBy: person.id })();
  db.insert(comment)
    .values({ issueId: filed.id, authorId: person.id, body: "mine" })
    .run();

  db.delete(invite).where(eq(invite.username, "leaver")).run();

  expect(
    db
      .select()
      .from(projectMember)
      .where(eq(projectMember.inviteId, leaver.id))
      .all(),
  ).toEqual([]);
  expect(
    db.select().from(actor).where(eq(actor.id, person.id)).get(),
  ).toMatchObject({ githubLogin: "leaver" });
  expect(
    db.select().from(issue).where(eq(issue.createdBy, person.id)).all(),
  ).toHaveLength(1);
  expect(
    db.select().from(comment).where(eq(comment.authorId, person.id)).all(),
  ).toHaveLength(1);
});

test("a project with issues cannot be deleted; one without drops its memberships", () => {
  const empty = db
    .insert(project)
    .values({ key: "GONE", name: "gone", createdBy: bot.id })
    .returning()
    .get();
  const viewer = db
    .insert(invite)
    .values({ username: "viewer", invitedBy: human.id })
    .returning()
    .get();
  db.insert(projectMember)
    .values([
      { inviteId: viewer.id, projectId: proj.id },
      { inviteId: viewer.id, projectId: empty.id },
    ])
    .run();

  expect(
    errorCode(() => db.delete(project).where(eq(project.id, proj.id)).run()),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  db.delete(project).where(eq(project.id, empty.id)).run();

  expect(
    db
      .select({ projectId: projectMember.projectId })
      .from(projectMember)
      .where(eq(projectMember.inviteId, viewer.id))
      .all(),
  ).toEqual([{ projectId: proj.id }]);
});

test.each([
  [
    "an invite's projects",
    eq(projectMember.inviteId, 1),
    "sqlite_autoindex_project_member_1",
  ],
  [
    "a project's invites",
    eq(projectMember.projectId, proj.id),
    "project_member_project_invite_idx",
  ],
])("%s are read from an index alone", (_, where, index) => {
  const plan = planOf(db.select().from(projectMember).where(where).toSQL());
  expect(plan).toContain(index);
  expect(plan).not.toContain("SCAN");
});

test("a key's actions are null or a set of known actions, and round-trip as an array", () => {
  const unscoped = db
    .insert(apiKey)
    .values({ actorId: bot.id, prefix: "trl_act0", hash: "c".repeat(64) })
    .returning()
    .get();
  const scoped = db
    .insert(apiKey)
    .values({
      actorId: bot.id,
      prefix: "trl_act1",
      hash: "c".repeat(64),
      actions: ["read", "issues", "comments", "status_updates", "admin"],
    })
    .returning()
    .get();
  expect(unscoped.actions).toBeNull();
  expect(
    db.select().from(apiKey).where(eq(apiKey.id, scoped.id)).get()?.actions,
  ).toEqual(["read", "issues", "comments", "status_updates", "admin"]);
});

test.each([
  ["malformed JSON", '["read"'],
  ["a non-array", '{"read":true}'],
  ["a bare string", '"read"'],
  ["an empty array", "[]"],
  ["a duplicate", '["read","issues","read"]'],
  [
    "a duplicate past the third slot",
    '["read","issues","comments","admin","admin"]',
  ],
  ["an unknown action", '["read","write"]'],
  ["a null member", '["read",null]'],
  ["a nested array", '[["read"]]'],
  [
    "more members than actions",
    '["read","issues","comments","status_updates","admin","read"]',
  ],
])("a key's actions as %s are rejected", (_, actions) => {
  expect(
    errorCode(() =>
      sqlite
        .prepare(
          "insert into api_key (id, actor_id, prefix, hash, created_at, actions) values (?, ?, ?, ?, 0, ?)",
        )
        .run(newId(), bot.id, `trl_${newId()}`, "d".repeat(64), actions),
    ),
  ).toBe("SQLITE_CONSTRAINT_CHECK");
});

test("a key's allowlist names an existing key and project, each pair once", () => {
  const key = db
    .insert(apiKey)
    .values({ actorId: bot.id, prefix: "trl_allow", hash: "e".repeat(64) })
    .returning()
    .get();
  db.insert(apiKeyProject)
    .values({ apiKeyId: key.id, projectId: proj.id })
    .run();

  expect(
    errorCode(() =>
      db
        .insert(apiKeyProject)
        .values({ apiKeyId: key.id, projectId: proj.id })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
  expect(
    errorCode(() =>
      db
        .insert(apiKeyProject)
        .values({ apiKeyId: "no-such-key", projectId: proj.id })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  expect(
    errorCode(() =>
      db
        .insert(apiKeyProject)
        .values({ apiKeyId: key.id, projectId: "no-such-project" })
        .run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
});

test("deleting a key drops its allowlist; a project on an allowlist cannot be deleted", () => {
  const scopedTo = db
    .insert(project)
    .values({ key: "BGP", name: "better giving", createdBy: bot.id })
    .returning()
    .get();
  const key = db
    .insert(apiKey)
    .values({ actorId: bot.id, prefix: "trl_gone", hash: "f".repeat(64) })
    .returning()
    .get();
  db.insert(apiKeyProject)
    .values({ apiKeyId: key.id, projectId: scopedTo.id })
    .run();

  expect(
    errorCode(() =>
      db.delete(project).where(eq(project.id, scopedTo.id)).run(),
    ),
  ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");

  db.delete(apiKey).where(eq(apiKey.id, key.id)).run();
  expect(
    db
      .select()
      .from(apiKeyProject)
      .where(eq(apiKeyProject.apiKeyId, key.id))
      .all(),
  ).toEqual([]);
  db.delete(project).where(eq(project.id, scopedTo.id)).run();
});

test.each([
  [
    "a key's projects",
    eq(apiKeyProject.apiKeyId, "k"),
    "sqlite_autoindex_api_key_project_1",
  ],
  [
    "a project's keys",
    eq(apiKeyProject.projectId, proj.id),
    "api_key_project_project_key_idx",
  ],
])("%s are read from an index alone", (_, where, index) => {
  const plan = planOf(db.select().from(apiKeyProject).where(where).toSQL());
  expect(plan).toContain(`USING COVERING INDEX ${index}`);
  expect(plan).not.toContain("SCAN");
});
