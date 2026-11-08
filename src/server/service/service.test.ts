import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { type ActivityEvent, createEventBus } from "../events/bus.js";
import { atFakeTime, projectKey } from "../test-app.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { createService, type Issue, type Project } from "./index.js";
import { createBot, createHuman } from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-service-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const bus = createEventBus();
const service = createService({ db, bus });
let published: ActivityEvent[] = [];
bus.subscribe((e) => published.push(e));
beforeEach(() => {
  published = [];
});

const bot = createBot(db, "builder").actor;
const human = createHuman(db, { displayName: "Justin" });

/** Every activity event, newest first, across pages (a single page caps at 200). */
function allActivity(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = service.listActivity(bot, { limit: 200, cursor });
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return events;
}

/** The one activity event `write` committed, after checking the bus saw exactly it. */
function onlyEventOf(write: () => unknown): ActivityEvent {
  const ids = (items: ActivityEvent[]) => new Set(items.map((e) => e.id));
  const before = ids(allActivity());
  write();
  const added = allActivity().filter((e) => !before.has(e.id));
  expect(added).toHaveLength(1);
  expect(published).toEqual(added);
  return added[0] as ActivityEvent;
}

test("creating a project commits one project.created event and publishes it", () => {
  let id = "";
  const event = onlyEventOf(() => {
    id = service.createProject(bot, { key: projectKey(), name: "trail" }).id;
  });
  expect(event).toMatchObject({
    actorId: bot.id,
    subjectType: "project",
    subjectId: id,
    projectId: id,
    action: "project.created",
    payload: { name: "trail", description: "" },
  });
  expect(service.getProject(bot, id).name).toBe("trail");
});

/** Checks `write` throws `error` and commits no event and publishes nothing. */
function rejectsCleanly(
  write: () => unknown,
  error: new (...a: never[]) => Error,
) {
  const before = allActivity();
  expect(write).toThrow(error);
  expect(allActivity()).toEqual(before);
  expect(published).toEqual([]);
}

test("a project with a blank name is rejected with no row and no event", () => {
  const before = service.listProjects(bot).items.length;
  rejectsCleanly(
    () => service.createProject(bot, { key: projectKey(), name: "  " }),
    ValidationError,
  );
  expect(service.listProjects(bot).items).toHaveLength(before);
});

test("a human cannot create a project", () => {
  rejectsCleanly(
    () => service.createProject(human, { key: projectKey(), name: "mine" }),
    ForbiddenError,
  );
});

test("a human files an issue unassigned; naming an assignee is refused and writes nothing", () => {
  const filed = service.createProject(bot, {
    key: projectKey(),
    name: "human filed",
  });
  published = [];
  const issue = service.createIssue(human, {
    projectId: filed.id,
    title: "from a human",
  });
  expect(issue.assigneeId).toBeNull();
  published = [];
  for (const assigneeId of [bot.id, human.id]) {
    rejectsCleanly(
      () =>
        service.createIssue(human, {
          projectId: filed.id,
          title: "assign it",
          assigneeId,
        }),
      ForbiddenError,
    );
  }
  expect(() =>
    service.createIssue(human, {
      projectId: filed.id,
      title: "assign it",
      assigneeId: bot.id,
    }),
  ).toThrow(
    "a human files an issue unassigned: drop assigneeId, and a bot assigns it",
  );
  expect(
    service.listIssues(bot, { projectId: filed.id }).items.map((i) => i.title),
  ).toEqual(["from a human"]);
});

const proj = service.createProject(bot, {
  key: projectKey(),
  name: "fixtures",
});

test("updating a project records each changed field from and to", () => {
  const event = onlyEventOf(() =>
    service.updateProject(bot, proj.id, { name: "renamed", description: "" }),
  );
  expect(event).toMatchObject({
    action: "project.updated",
    subjectId: proj.id,
    payload: { name: { from: "fixtures", to: "renamed" } },
  });
  expect(event.payload).not.toHaveProperty("description");
});

test("an update that changes nothing writes no event", () => {
  const current = service.getProject(bot, proj.id);
  rejectsNothing(() =>
    service.updateProject(bot, proj.id, { name: current.name }),
  );
  const issue = service.createIssue(bot, { projectId: proj.id, title: "same" });
  published = [];
  rejectsNothing(() =>
    service.updateIssue(bot, issue.id, { title: "same", status: "open" }),
  );
});

/** Checks `write` succeeds yet commits and publishes no event. */
function rejectsNothing(write: () => unknown) {
  const before = allActivity();
  write();
  expect(allActivity()).toEqual(before);
  expect(published).toEqual([]);
}

test("a human can file an issue and comment on it", () => {
  let issueId = "";
  const filed = onlyEventOf(() => {
    issueId = service.createIssue(human, {
      projectId: proj.id,
      title: "Bug from a human",
    }).id;
  });
  expect(filed).toMatchObject({
    actorId: human.id,
    action: "issue.created",
    subjectType: "issue",
    subjectId: issueId,
    projectId: proj.id,
    payload: { title: "Bug from a human", status: "open", assigneeId: null },
  });
  published = [];
  let commentId = "";
  const commented = onlyEventOf(() => {
    commentId = service.addComment(human, { issueId, body: "repro steps" }).id;
  });
  expect(commented).toMatchObject({
    actorId: human.id,
    action: "comment.created",
    subjectType: "comment",
    subjectId: commentId,
    projectId: proj.id,
    payload: { issueId, body: "repro steps" },
  });
  expect(service.listComments(human, issueId).items).toMatchObject([
    { id: commentId, authorId: human.id, body: "repro steps" },
  ]);
});

test("a human cannot update a project or an issue", () => {
  const issue = service.createIssue(bot, { projectId: proj.id, title: "t" });
  published = [];
  rejectsCleanly(
    () => service.updateProject(human, proj.id, { name: "x" }),
    ForbiddenError,
  );
  rejectsCleanly(
    () => service.updateIssue(human, issue.id, { status: "done" }),
    ForbiddenError,
  );
  expect(service.getIssue(bot, issue.id).status).toBe("open");
});

test("a status change is issue.updated with status from and to", () => {
  const issue = service.createIssue(bot, { projectId: proj.id, title: "t" });
  published = [];
  const event = onlyEventOf(() =>
    service.updateIssue(bot, issue.id, { status: "done", assigneeId: bot.id }),
  );
  expect(event).toMatchObject({
    action: "issue.updated",
    subjectId: issue.id,
    projectId: proj.id,
    payload: {
      status: { from: "open", to: "done" },
      assigneeId: { from: null, to: bot.id },
    },
  });
  expect(service.getIssue(bot, issue.id)).toMatchObject({
    status: "done",
    assigneeId: bot.id,
  });
});

describe("completedAt", () => {
  test("is set when an issue moves to done, kept through canceled, cleared when it reopens", () => {
    const issue = service.createIssue(bot, { projectId: proj.id, title: "c" });
    expect(issue.completedAt).toBeNull();
    const [done] = atFakeTime([
      () => service.updateIssue(bot, issue.id, { status: "done" }),
    ]);
    expect(done?.completedAt).toBeInstanceOf(Date);
    const doneAt = done?.completedAt?.getTime();
    expect(
      service.updateIssue(bot, issue.id, { status: "canceled" }).completedAt,
    ).toEqual(new Date(doneAt as number));
    expect(
      service.updateIssue(bot, issue.id, { status: "in_progress" }).completedAt,
    ).toBeNull();
    expect(service.getIssue(bot, issue.id).completedAt).toBeNull();
  });

  test("is set when an open issue is canceled, and untouched by an edit that keeps it open", () => {
    const issue = service.createIssue(bot, { projectId: proj.id, title: "c" });
    expect(
      service.updateIssue(bot, issue.id, { title: "c2" }).completedAt,
    ).toBeNull();
    const canceled = service.updateIssue(bot, issue.id, { status: "canceled" });
    expect(canceled.completedAt).toBeInstanceOf(Date);
    expect(service.getIssue(bot, issue.id).completedAt).toEqual(
      canceled.completedAt,
    );
  });
});

test("failed issue and comment writes leave no row and no event", () => {
  const issue = service.createIssue(bot, { projectId: proj.id, title: "t" });
  published = [];
  const issuesBefore = service.listIssues(bot, { limit: 200 }).items;
  rejectsCleanly(
    () => service.createIssue(bot, { projectId: "missing", title: "orphan" }),
    NotFoundError,
  );
  rejectsCleanly(
    () => service.createIssue(bot, { projectId: proj.id, title: " " }),
    ValidationError,
  );
  rejectsCleanly(
    () =>
      service.createIssue(bot, {
        projectId: proj.id,
        title: "t",
        assigneeId: "nobody",
      }),
    ValidationError,
  );
  expect(service.listIssues(bot, { limit: 200 }).items).toEqual(issuesBefore);
  rejectsCleanly(
    () => service.updateIssue(bot, issue.id, { status: "closed" as "done" }),
    ValidationError,
  );
  rejectsCleanly(
    () => service.updateIssue(bot, "missing", { status: "done" }),
    NotFoundError,
  );
  rejectsCleanly(
    () => service.addComment(bot, { issueId: "missing", body: "hi" }),
    NotFoundError,
  );
  rejectsCleanly(
    () => service.addComment(bot, { issueId: issue.id, body: "" }),
    ValidationError,
  );
  expect(service.listComments(bot, issue.id).items).toEqual([]);
});

test("a write the database rejects leaves no row and no event", () => {
  const ghost = { id: "not-an-actor", kind: "bot" as const };
  const before = service.listProjects(bot, { limit: 200 }).items;
  rejectsCleanly(
    () => service.createProject(ghost, { key: projectKey(), name: "x" }),
    Error,
  );
  expect(service.listProjects(bot, { limit: 200 }).items).toEqual(before);
});

test("the bus publishes only once the event is visible to other connections", () => {
  const other = openDatabase(join(dir, "trail.db"));
  const seenByOther: boolean[] = [];
  const unsubscribe = bus.subscribe((e) => {
    const row = other.$client
      .prepare("select id from activity_event where id = ?")
      .get(e.id);
    seenByOther.push(row !== undefined);
  });
  try {
    service.createProject(bot, { key: projectKey(), name: "committed" });
  } finally {
    unsubscribe();
    other.$client.close();
  }
  expect(seenByOther).toEqual([true]);
});

test("an update is attributed to the acting bot, not the row's creator", () => {
  const editor = createBot(db, "editor").actor;
  const project = service.createProject(bot, {
    key: projectKey(),
    name: "authored",
  });
  const issue = service.createIssue(bot, {
    projectId: project.id,
    title: "authored",
  });
  published = [];

  const projectEvent = onlyEventOf(() =>
    service.updateProject(editor, project.id, { name: "edited" }),
  );
  published = [];
  const issueEvent = onlyEventOf(() =>
    service.updateIssue(editor, issue.id, { status: "done" }),
  );

  expect(projectEvent).toMatchObject({
    action: "project.updated",
    actorId: editor.id,
  });
  expect(issueEvent).toMatchObject({
    action: "issue.updated",
    actorId: editor.id,
  });
  expect(service.getProject(bot, project.id).createdBy).toBe(bot.id);
  expect(service.getIssue(bot, issue.id).createdBy).toBe(bot.id);
});

describe("updatedAt", () => {
  test("a project update moves updatedAt past createdAt and leaves createdAt alone", () => {
    const project = atFakeTime([
      () => service.createProject(bot, { key: projectKey(), name: "ticking" }),
    ])[0] as Project;
    const updated = atFakeTime([
      () => service.updateProject(bot, project.id, { name: "ticked" }),
    ])[0] as Project;
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      project.updatedAt.getTime(),
    );
    expect(updated.createdAt).toEqual(project.createdAt);
    expect(service.getProject(bot, project.id).updatedAt).toEqual(
      updated.updatedAt,
    );
  });

  test("an issue update moves updatedAt past createdAt and leaves createdAt alone", () => {
    const project = service.createProject(bot, {
      key: projectKey(),
      name: "issue clock",
    });
    const issue = atFakeTime([
      () => service.createIssue(bot, { projectId: project.id, title: "tick" }),
    ])[0] as Issue;
    const updated = atFakeTime([
      () => service.updateIssue(bot, issue.id, { status: "in_progress" }),
    ])[0] as Issue;
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      issue.updatedAt.getTime(),
    );
    expect(updated.createdAt).toEqual(issue.createdAt);
    expect(service.getIssue(bot, issue.id).updatedAt).toEqual(
      updated.updatedAt,
    );
  });

  test("a project patch that changes nothing leaves the row, updatedAt included, as it was", () => {
    const created = atFakeTime([
      () =>
        service.createProject(bot, {
          key: projectKey(),
          name: "still",
          description: "d",
        }),
    ])[0] as Project;
    published = [];
    const result = atFakeTime([
      () =>
        service.updateProject(bot, created.id, {
          name: "still",
          description: "d",
        }),
    ])[0] as Project;
    expect(result).toEqual(created);
    expect(service.getProject(bot, created.id)).toEqual(created);
    expect(published).toEqual([]);
  });

  test("an issue patch that changes nothing leaves the row, updatedAt included, as it was", () => {
    const project = service.createProject(bot, {
      key: projectKey(),
      name: "issue still",
    });
    const created = atFakeTime([
      () => service.createIssue(bot, { projectId: project.id, title: "same" }),
    ])[0] as Issue;
    published = [];
    const result = atFakeTime([
      () =>
        service.updateIssue(bot, created.id, { title: "same", status: "open" }),
    ])[0] as Issue;
    expect(result).toEqual(created);
    expect(service.getIssue(bot, created.id)).toEqual(created);
    expect(published).toEqual([]);
  });
});

describe("a write and its activity event commit together", () => {
  const rejectEvents = () =>
    db.$client.exec(
      `create trigger reject_event before insert on activity_event
       begin select raise(abort, 'event rejected'); end`,
    );
  const allowEvents = () =>
    db.$client.exec("drop trigger if exists reject_event");
  afterEach(allowEvents);

  test("an event the database refuses rolls the write back; with the refusal lifted the same calls commit", () => {
    const project = service.createProject(bot, {
      key: projectKey(),
      name: "atomic",
    });
    const issue = service.createIssue(bot, {
      projectId: project.id,
      title: "before",
    });
    published = [];
    const issuesBefore = service.listIssues(bot, { projectId: project.id });
    const issueBefore = service.getIssue(bot, issue.id);
    const eventsBefore = allActivity();

    const writes = {
      createIssue: () =>
        service.createIssue(bot, { projectId: project.id, title: "after" }),
      updateIssue: () =>
        service.updateIssue(bot, issue.id, { title: "after", status: "done" }),
      addComment: () =>
        service.addComment(bot, { issueId: issue.id, body: "after" }),
    };

    rejectEvents();
    for (const write of Object.values(writes)) {
      expect(write).toThrow("event rejected");
    }
    expect(service.listIssues(bot, { projectId: project.id })).toEqual(
      issuesBefore,
    );
    expect(service.getIssue(bot, issue.id)).toEqual(issueBefore);
    expect(service.listComments(bot, issue.id).items).toEqual([]);
    expect(allActivity()).toEqual(eventsBefore);
    expect(published).toEqual([]);

    allowEvents();
    for (const write of Object.values(writes)) write();
    const issuesAfter = service.listIssues(bot, { projectId: project.id });
    expect(issuesAfter.items).toHaveLength(2);
    expect(service.getIssue(bot, issue.id)).toMatchObject({
      title: "after",
      status: "done",
    });
    expect(service.listComments(bot, issue.id).items).toHaveLength(1);
    expect(published.map((e) => e.action)).toEqual([
      "issue.created",
      "issue.updated",
      "comment.created",
    ]);
  });
});

describe("paging and filters", () => {
  const titles = ["one", "two", "three", "four", "five"];
  const [paged] = atFakeTime([
    () => service.createProject(bot, { key: projectKey(), name: "paged" }),
  ]) as [Project];
  const issues = atFakeTime(
    titles.map(
      (title) => () => service.createIssue(bot, { projectId: paged.id, title }),
    ),
  );
  atFakeTime([
    () => service.updateIssue(bot, issues[1]?.id ?? "", { status: "done" }),
    () => service.updateIssue(bot, issues[2]?.id ?? "", { assigneeId: bot.id }),
  ]);

  /** Walks every page of `list` at `limit`, returning ids in order. */
  function walk<T extends { id: string }>(
    list: (cursor?: string) => { items: T[]; nextCursor: string | null },
    key: (item: T) => string = (item) => item.id,
  ): string[][] {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = list(cursor);
      pages.push(page.items.map(key));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  }

  test("issues page newest first and the cursor round-trips", () => {
    const ids = issues.map((i) => i.id).reverse();
    const pages = walk((cursor) =>
      service.listIssues(bot, { projectId: paged.id, cursor, limit: 2 }),
    );
    expect(pages).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
  });

  test("rows sharing a millisecond each land on exactly one page", () => {
    const tied = service.createProject(bot, {
      key: projectKey(),
      name: "tied",
    });
    const ids = atFakeTime(
      ["a", "b", "c", "d"].map(
        (title) => () =>
          service.createIssue(bot, { projectId: tied.id, title }).id,
      ),
      0,
    );
    const pages = walk((cursor) =>
      service.listIssues(bot, { projectId: tied.id, cursor, limit: 1 }),
    );
    expect(pages.flat().sort()).toEqual([...ids].sort());
  });

  test("issues filter by status and assignee", () => {
    expect(
      service
        .listIssues(bot, { projectId: paged.id, status: "done" })
        .items.map((i) => i.title),
    ).toEqual(["two"]);
    expect(
      service
        .listIssues(bot, { projectId: paged.id, assigneeId: bot.id })
        .items.map((i) => i.title),
    ).toEqual(["three"]);
  });

  test("activity pages newest first, filtered by project and actor", () => {
    const all = service.listActivity(bot, { projectId: paged.id }).items;
    expect(all.map((e) => e.action)).toEqual([
      "issue.updated",
      "issue.updated",
      ...titles.map(() => "issue.created"),
      "project.created",
    ]);
    const pages = walk((cursor) =>
      service.listActivity(bot, { projectId: paged.id, cursor, limit: 3 }),
    );
    expect(pages.flat()).toEqual(all.map((e) => e.id));
    expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
  });

  test("activity filters by actor within a project", () => {
    const shared = service.createProject(bot, {
      key: projectKey(),
      name: "shared",
    });
    const [filed] = atFakeTime([
      () =>
        service.createIssue(human, {
          projectId: shared.id,
          title: "from human",
        }),
    ]);
    const mine = (actorId: string) =>
      service
        .listActivity(bot, { projectId: shared.id, actorId })
        .items.map((e) => e.action);
    expect(mine(human.id)).toEqual(["issue.created"]);
    expect(mine(bot.id)).toEqual(["project.created"]);
    expect(filed?.createdBy).toBe(human.id);
  });

  test("a result that is an exact multiple of the limit ends without an empty page", () => {
    const exact = service.createProject(bot, {
      key: projectKey(),
      name: "exact",
    });
    const ids = atFakeTime(
      ["a", "b", "c", "d"].map(
        (title) => () =>
          service.createIssue(bot, { projectId: exact.id, title }).id,
      ),
    ).reverse();
    const first = service.listIssues(bot, { projectId: exact.id, limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = service.listIssues(bot, {
      projectId: exact.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  test("an empty list is one page with no cursor", () => {
    const empty = service.createProject(bot, {
      key: projectKey(),
      name: "empty",
    });
    expect(service.listIssues(bot, { projectId: empty.id })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("activity rows sharing a millisecond each land on exactly one page", () => {
    const tied = service.createProject(bot, {
      key: projectKey(),
      name: "tied activity",
    });
    const filed = atFakeTime(
      ["a", "b", "c", "d"].map(
        (title) => () =>
          service.createIssue(bot, { projectId: tied.id, title }),
      ),
      0,
    );
    const subjects = [tied.id, ...filed.map((i) => i.id)];
    const pages = walk(
      (cursor) =>
        service.listActivity(bot, { projectId: tied.id, cursor, limit: 1 }),
      (event) => event.subjectId,
    );
    expect(pages).toHaveLength(subjects.length);
    expect(pages.flat().sort()).toEqual([...subjects].sort());
  });

  test("comments sharing a millisecond each land on exactly one page", () => {
    const own = service.createProject(bot, {
      key: projectKey(),
      name: "tied comments",
    });
    const issue = service.createIssue(bot, { projectId: own.id, title: "t" });
    const ids = atFakeTime(
      ["a", "b", "c", "d"].map(
        (body) => () => service.addComment(bot, { issueId: issue.id, body }).id,
      ),
      0,
    );
    const pages = walk((cursor) =>
      service.listComments(bot, issue.id, { cursor, limit: 1 }),
    );
    expect(pages).toHaveLength(ids.length);
    expect(pages.flat().sort()).toEqual([...ids].sort());
  });

  test("comments page oldest first", () => {
    const own = service.createProject(bot, {
      key: projectKey(),
      name: "comment paging",
    });
    const issueId = service.createIssue(bot, {
      projectId: own.id,
      title: "t",
    }).id;
    const ids = atFakeTime(
      ["a", "b", "c"].map(
        (body) => () => service.addComment(bot, { issueId, body }).id,
      ),
    );
    const pages = walk((cursor) =>
      service.listComments(bot, issueId, { cursor, limit: 2 }),
    );
    expect(pages).toEqual([ids.slice(0, 2), ids.slice(2)]);
  });

  test("a malformed cursor or out-of-range limit is a ValidationError", () => {
    const notJson = Buffer.from("nope").toString("base64url");
    const wrongShape = Buffer.from('{"a":1}').toString("base64url");
    const badTime = Buffer.from('["soon","x"]').toString("base64url");
    for (const cursor of ["%%%", notJson, wrongShape, badTime]) {
      expect(() => service.listIssues(bot, { cursor })).toThrow(
        ValidationError,
      );
      expect(() => service.listActivity(bot, { cursor })).toThrow(
        ValidationError,
      );
    }
    for (const limit of [0, 201, 1.5]) {
      expect(() => service.listIssues(bot, { limit })).toThrow(ValidationError);
    }
  });

  test("listing comments of an unknown issue is a NotFoundError", () => {
    expect(() => service.listComments(bot, "missing")).toThrow(NotFoundError);
  });
});
