import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { type ActivityEvent, createEventBus } from "../events/bus.js";
import { atFakeTime } from "../test-app.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { createService, type Project } from "./index.js";
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
    id = service.createProject(bot, { name: "trail" }).id;
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
    () => service.createProject(bot, { name: "  " }),
    ValidationError,
  );
  expect(service.listProjects(bot).items).toHaveLength(before);
});

test("a human cannot create a project", () => {
  rejectsCleanly(
    () => service.createProject(human, { name: "mine" }),
    ForbiddenError,
  );
});

const proj = service.createProject(bot, { name: "fixtures" });

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
  rejectsCleanly(() => service.createProject(ghost, { name: "x" }), Error);
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
    service.createProject(bot, { name: "committed" });
  } finally {
    unsubscribe();
    other.$client.close();
  }
  expect(seenByOther).toEqual([true]);
});

describe("paging and filters", () => {
  const titles = ["one", "two", "three", "four", "five"];
  const [paged] = atFakeTime([
    () => service.createProject(bot, { name: "paged" }),
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
  ): string[][] {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = list(cursor);
      pages.push(page.items.map((i) => i.id));
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
    const tied = service.createProject(bot, { name: "tied" });
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
    const shared = service.createProject(bot, { name: "shared" });
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
    const exact = service.createProject(bot, { name: "exact" });
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
    const empty = service.createProject(bot, { name: "empty" });
    expect(service.listIssues(bot, { projectId: empty.id })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("comments page oldest first", () => {
    const issueId = issues[0]?.id ?? "";
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
