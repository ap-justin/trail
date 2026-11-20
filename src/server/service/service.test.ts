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
  vi,
} from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { type ActivityEvent, createEventBus } from "../events/bus.js";
import {
  atFakeTime,
  projectKey,
  testPullRequests,
  testWebhooks,
} from "../test-app.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import {
  createService,
  type Issue,
  type NamedProduct,
  type ProductView as Product,
} from "./index.js";
import { createBot, createHuman } from "./keys.js";

/** A product read by a key whose products include it, which reads it whole. */
const whole = (read: Product | NamedProduct): Product => {
  if (!("createdBy" in read)) throw new Error(`read ${read.key} named only`);
  return read;
};

const dir = mkdtempSync(join(tmpdir(), "trail-service-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const bus = createEventBus();
const service = createService({
  db,
  bus,
  webhooks: testWebhooks,
  pullRequests: testPullRequests(db),
});
let published: ActivityEvent[] = [];
bus.subscribe((e) => published.push(e));
beforeEach(() => {
  published = [];
});

const bot = createBot(db, "builder").actor;
const human = createHuman(db, { displayName: "Pat" });

/** Every activity event, newest first, across pages (a single page caps at 200). */
function allActivity(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = service.listActivity(bot, { limit: 200, cursor });
    // the bus carries the stored event; a listed one adds its product key and project slug
    events.push(
      ...page.items.map(({ productKey, projectSlug, ...event }) => event),
    );
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
    id = service.createProduct(bot, { key: projectKey(), name: "trail" }).id;
  });
  expect(event).toMatchObject({
    actorId: bot.id,
    subjectType: "product",
    subjectId: id,
    productId: id,
    action: "product.created",
    payload: { name: "trail", description: "" },
  });
  expect(service.getProduct(bot, id).name).toBe("trail");
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
  const before = service.listProducts(bot).items.length;
  rejectsCleanly(
    () => service.createProduct(bot, { key: projectKey(), name: "  " }),
    ValidationError,
  );
  expect(service.listProducts(bot).items).toHaveLength(before);
});

test("a human cannot create a project", () => {
  rejectsCleanly(
    () => service.createProduct(human, { key: projectKey(), name: "mine" }),
    ForbiddenError,
  );
});

test("a person cannot add a note, and no note exists after the refusal", () => {
  const target = service.createProduct(bot, { key: projectKey(), name: "p" });
  published = [];
  rejectsCleanly(
    () => service.addNote(human, { product: target.key, title: "record" }),
    ForbiddenError,
  );
  expect(() =>
    service.addNote(human, { product: target.key, title: "record" }),
  ).toThrow("only a bot may add a note");
  expect(published).toEqual([]);
  expect(
    service.listItems(bot, { product: target.key, type: "note" }).items,
  ).toEqual([]);
  expect(
    service.addNote(bot, { product: target.key, title: "record" }),
  ).toMatchObject({ type: "note", status: "current" });
  expect(published.map((e) => e.action)).toEqual(["issue.created"]);
});

test.each([
  ["todo", "current"],
  ["todo", "archived"],
  ["issue", "current"],
  ["issue", "archived"],
] as const)(
  "listing %ss by note status %s is refused, and the message sends the caller to type note",
  (type, status) => {
    const target = service.createProduct(bot, { key: projectKey(), name: "p" });
    const listing = () =>
      service.listItems(bot, { product: target.key, type, status });
    expect(listing).toThrow(ValidationError);
    expect(listing).toThrow(`never ${status}`);
    expect(listing).toThrow(/send type note/);
  },
);

/** The query plan of every statement on the issue table that `run` executes, as SQLite would run it with the same parameters. */
function issuePlansOf(run: () => void): string[] {
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  const plans: string[] = [];
  const spy = vi.spyOn(client, "prepare").mockImplementation((source) => {
    const statement = prepare(source);
    if (!/ from "issue"/.test(source)) return statement;
    const all = statement.all.bind(statement);
    statement.all = (...params: unknown[]) => {
      plans.push(
        (
          prepare(`explain query plan ${source}`).all(...params) as {
            detail: string;
          }[]
        )
          .map((r) => r.detail)
          .join("\n"),
      );
      return all(...params);
    };
    return statement;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return plans;
}

test("listing a product's notes with no status lists current and archived ones, newest first, and reads them off the status index", () => {
  const target = service.createProduct(bot, { key: projectKey(), name: "p" });
  service.addNote(bot, { product: target.key, title: "first" });
  for (let i = 0; i < 20; i++) {
    service.addTodo(bot, { product: target.key, title: `work ${i}` });
    service.fileIssue(bot, { product: target.key, title: `request ${i}` });
  }
  const archived = service.addNote(bot, { product: target.key, title: "old" });
  service.updateItem(bot, archived.id, { status: "archived" });
  service.addNote(bot, { product: target.key, title: "last" });
  // the statistics `pragma optimize` gathers on a served file, which the planner weighs
  db.$client.exec("analyze");

  let listed: Issue[] = [];
  const plans = issuePlansOf(() => {
    listed = service.listItems(bot, {
      product: target.key,
      type: "note",
    }).items;
  });
  expect(listed.map((n) => [n.title, n.status])).toEqual([
    ["last", "current"],
    ["old", "archived"],
    ["first", "current"],
  ]);
  const page = plans.find((p) => /\bissue_product_\w*idx\b/.test(p));
  expect(page).toMatch(/\bissue_product_status_created_idx\b/);
});

test("the service refuses an about of more than 50 keys before looking any up, naming the field and the count", () => {
  const target = service.createProduct(bot, { key: projectKey(), name: "p" });
  const keys = Array.from({ length: 51 }, (_, i) => `${target.key}-${i + 1}`);
  expect(() =>
    service.addNote(bot, { product: target.key, title: "wide", about: keys }),
  ).toThrow(
    "about names 51 items, over the limit of 50: a note is about at most 50 items",
  );
  expect(
    service.listItems(bot, { product: target.key, type: "note" }).items,
  ).toEqual([]);
});

test("a person can file an issue but not add a todo, nor create or fill a project", () => {
  const target = service.createProduct(bot, { key: projectKey(), name: "p" });
  const filed = service.fileIssue(human, { product: target.key, title: "x" });
  expect(filed).toMatchObject({ type: "issue", status: "triage" });
  published = [];
  rejectsCleanly(
    () => service.addTodo(human, { product: target.key, title: "plan" }),
    ForbiddenError,
  );
  rejectsCleanly(
    () =>
      service.createProject(human, { name: "mine", products: [target.key] }),
    ForbiddenError,
  );
  const made = service.createProject(bot, {
    name: "theirs",
    products: [target.key],
  });
  published = [];
  rejectsCleanly(
    () => service.addToProject(human, made.slug, [filed.key]),
    ForbiddenError,
  );
});

test("a human can neither set nor clear a title", () => {
  rejectsCleanly(() => service.setMyTitle(human, "Owner"), ForbiddenError);
  rejectsCleanly(() => service.clearMyTitle(human), ForbiddenError);
});

test("a human files an issue unassigned; naming an assignee is refused and writes nothing", () => {
  const filed = service.createProduct(bot, {
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
    "a person files an issue unassigned: drop the assignee, and the product's bot assigns it",
  );
  expect(
    service.listItems(bot, { product: filed.id }).items.map((i) => i.title),
  ).toEqual(["from a human"]);
});

// no owner, so what the bot creates in it are issues, as before products had owners
const proj = service.createProduct(bot, {
  key: projectKey(),
  name: "fixtures",
  owner: null,
});

test("the legacy create makes a todo when its product's owner files it, else an issue in triage", () => {
  const owned = service.createProduct(bot, {
    key: projectKey(),
    name: "owned",
  });
  const other = createBot(db, "outsider").actor;
  const filed = (actor: typeof bot | typeof human) =>
    service.createIssue(actor, { projectId: owned.id, title: "t" });
  expect(filed(bot)).toMatchObject({
    type: "todo",
    status: "open",
    assigneeId: bot.id,
  });
  expect(filed(other)).toMatchObject({
    type: "issue",
    status: "triage",
    assigneeId: null,
  });
  expect(filed(human)).toMatchObject({ type: "issue", status: "triage" });
  // a product with no owner: even its creator files issues
  expect(
    service.createIssue(bot, { projectId: proj.id, title: "t" }),
  ).toMatchObject({ type: "issue", status: "triage" });
});

test("updating a project records each changed field from and to", () => {
  const event = onlyEventOf(() =>
    service.updateProduct(bot, proj.id, { name: "renamed", description: "" }),
  );
  expect(event).toMatchObject({
    action: "product.updated",
    subjectId: proj.id,
    payload: { name: { from: "fixtures", to: "renamed" } },
  });
  expect(event.payload).not.toHaveProperty("description");
});

test("an update that changes nothing writes no event", () => {
  const current = service.getProduct(bot, proj.id);
  rejectsNothing(() =>
    service.updateProduct(bot, proj.id, { name: current.name }),
  );
  const issue = service.createIssue(bot, { projectId: proj.id, title: "same" });
  published = [];
  rejectsNothing(() =>
    service.updateItem(bot, issue.id, { title: "same", status: "triage" }),
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
    productId: proj.id,
    payload: { title: "Bug from a human", status: "triage", assigneeId: null },
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
    productId: proj.id,
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
    () => service.updateProduct(human, proj.id, { name: "x" }),
    ForbiddenError,
  );
  rejectsCleanly(
    () => service.updateItem(human, issue.id, { status: "done" }),
    ForbiddenError,
  );
  expect(service.getItem(bot, issue.id).status).toBe("triage");
});

test.each([
  [
    "post a status update",
    () =>
      service.createStatusUpdate(human, {
        product: proj.id,
        body: "all good",
        health: "on_track",
      }),
  ],
  [
    "create a label",
    () => service.createLabel(human, { productId: proj.id, name: "human" }),
  ],
  [
    "import a project",
    () =>
      service.importProject(human, {
        externalRef: "human-import",
        key: projectKey(),
        name: "imported by a human",
        issues: [],
      }),
  ],
])("a human cannot %s", (_name, write) => {
  rejectsCleanly(write, ForbiddenError);
});

test("a status change is issue.updated with status from and to", () => {
  const issue = service.createIssue(bot, { projectId: proj.id, title: "t" });
  published = [];
  const event = onlyEventOf(() =>
    service.updateItem(bot, issue.id, { status: "done", assigneeId: bot.id }),
  );
  expect(event).toMatchObject({
    action: "issue.updated",
    subjectId: issue.id,
    productId: proj.id,
    payload: {
      status: { from: "triage", to: "done" },
      assigneeId: { from: null, to: bot.id },
    },
  });
  expect(service.getItem(bot, issue.id)).toMatchObject({
    status: "done",
    assigneeId: bot.id,
  });
});

test("label names match across ASCII case only, the same in one request as across requests", () => {
  const p = service.createProduct(bot, { key: projectKey(), name: "labels" });
  const issue = service.createIssue(bot, {
    projectId: p.id,
    title: "t",
    labels: ["Foo", "foo", "Équipe", "équipe"],
  });
  expect(issue.labels).toEqual(["Foo", "Équipe", "équipe"]);
  // "ÉQUIPE" differs from "Équipe" in A-Z only, so it is the same label
  expect(
    service.updateItem(bot, issue.id, { labels: ["FOO", "ÉQUIPE"] }).labels,
  ).toEqual(["Foo", "Équipe"]);
  expect(
    service
      .listLabels(bot, p.id)
      .items.map((l) => l.name)
      .sort(),
  ).toEqual(["Foo", "Équipe", "équipe"]);
});

describe("completedAt", () => {
  test("is set when an issue moves to done, kept through canceled, cleared when it reopens", () => {
    const issue = service.createIssue(bot, { projectId: proj.id, title: "c" });
    expect(issue.completedAt).toBeNull();
    const [done] = atFakeTime([
      () => service.updateItem(bot, issue.id, { status: "done" }),
    ]);
    expect(done?.completedAt).toBeInstanceOf(Date);
    const doneAt = done?.completedAt?.getTime();
    expect(
      service.updateItem(bot, issue.id, { status: "canceled" }).completedAt,
    ).toEqual(new Date(doneAt as number));
    expect(
      service.updateItem(bot, issue.id, { status: "in_progress" }).completedAt,
    ).toBeNull();
    expect(service.getItem(bot, issue.id).completedAt).toBeNull();
  });

  test("is set when an open issue is canceled, and untouched by an edit that keeps it open", () => {
    const issue = service.createIssue(bot, { projectId: proj.id, title: "c" });
    expect(
      service.updateItem(bot, issue.id, { title: "c2" }).completedAt,
    ).toBeNull();
    const canceled = service.updateItem(bot, issue.id, { status: "canceled" });
    expect(canceled.completedAt).toBeInstanceOf(Date);
    expect(service.getItem(bot, issue.id).completedAt).toEqual(
      canceled.completedAt,
    );
  });
});

test("failed issue and comment writes leave no row and no event", () => {
  const issue = service.createIssue(bot, { projectId: proj.id, title: "t" });
  published = [];
  const issuesBefore = service.listItems(bot, { limit: 200 }).items;
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
  expect(service.listItems(bot, { limit: 200 }).items).toEqual(issuesBefore);
  rejectsCleanly(
    () => service.updateItem(bot, issue.id, { status: "closed" as "done" }),
    ValidationError,
  );
  rejectsCleanly(
    () => service.updateItem(bot, "missing", { status: "done" }),
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
  const before = service.listProducts(bot, { limit: 200 }).items;
  rejectsCleanly(
    () => service.createProduct(ghost, { key: projectKey(), name: "x" }),
    Error,
  );
  expect(service.listProducts(bot, { limit: 200 }).items).toEqual(before);
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
    service.createProduct(bot, { key: projectKey(), name: "committed" });
  } finally {
    unsubscribe();
    other.$client.close();
  }
  expect(seenByOther).toEqual([true]);
});

test("an update is attributed to the acting bot, not the row's creator", () => {
  const editor = createBot(db, "editor").actor;
  const project = service.createProduct(bot, {
    key: projectKey(),
    name: "authored",
  });
  const issue = service.createIssue(bot, {
    projectId: project.id,
    title: "authored",
  });
  published = [];

  const projectEvent = onlyEventOf(() =>
    service.updateProduct(editor, project.id, { name: "edited" }),
  );
  published = [];
  const issueEvent = onlyEventOf(() =>
    service.updateItem(editor, issue.id, { status: "done" }),
  );

  expect(projectEvent).toMatchObject({
    action: "product.updated",
    actorId: editor.id,
  });
  expect(issueEvent).toMatchObject({
    action: "issue.updated",
    actorId: editor.id,
  });
  expect(whole(service.getProduct(bot, project.id)).createdBy).toBe(bot.id);
  expect(service.getItem(bot, issue.id).createdBy).toBe(bot.id);
});

describe("updatedAt", () => {
  test("a project update moves updatedAt past createdAt and leaves createdAt alone", () => {
    const project = atFakeTime([
      () => service.createProduct(bot, { key: projectKey(), name: "ticking" }),
    ])[0] as Product;
    const updated = atFakeTime([
      () => service.updateProduct(bot, project.id, { name: "ticked" }),
    ])[0] as Product;
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      project.updatedAt.getTime(),
    );
    expect(updated.createdAt).toEqual(project.createdAt);
    expect(whole(service.getProduct(bot, project.id)).updatedAt).toEqual(
      updated.updatedAt,
    );
  });

  test("an issue update moves updatedAt past createdAt and leaves createdAt alone", () => {
    const project = service.createProduct(bot, {
      key: projectKey(),
      name: "issue clock",
    });
    const issue = atFakeTime([
      () => service.createIssue(bot, { projectId: project.id, title: "tick" }),
    ])[0] as Issue;
    const updated = atFakeTime([
      () => service.updateItem(bot, issue.id, { status: "in_progress" }),
    ])[0] as Issue;
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      issue.updatedAt.getTime(),
    );
    expect(updated.createdAt).toEqual(issue.createdAt);
    expect(service.getItem(bot, issue.id).updatedAt).toEqual(updated.updatedAt);
  });

  test("a project patch that changes nothing leaves the row, updatedAt included, as it was", () => {
    const created = atFakeTime([
      () =>
        service.createProduct(bot, {
          key: projectKey(),
          name: "still",
          description: "d",
        }),
    ])[0] as Product;
    published = [];
    const result = atFakeTime([
      () =>
        service.updateProduct(bot, created.id, {
          name: "still",
          description: "d",
        }),
    ])[0] as Product;
    expect(result).toEqual(created);
    expect(service.getProduct(bot, created.id)).toEqual({
      ...created,
      notes: { current: 0, archived: 0 },
    });
    expect(published).toEqual([]);
  });

  test("an issue patch that changes nothing leaves the row, updatedAt included, as it was", () => {
    const project = service.createProduct(bot, {
      key: projectKey(),
      name: "issue still",
    });
    const created = atFakeTime([
      () => service.createIssue(bot, { projectId: project.id, title: "same" }),
    ])[0] as Issue;
    published = [];
    const result = atFakeTime([
      () =>
        service.updateItem(bot, created.id, { title: "same", status: "open" }),
    ])[0] as Issue;
    expect(result).toEqual(created);
    expect(service.getItem(bot, created.id)).toEqual({
      ...created,
      notes: [],
      notesCount: { current: 0, archived: 0 },
      access: "product",
    });
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
    const project = service.createProduct(bot, {
      key: projectKey(),
      name: "atomic",
    });
    const issue = service.createIssue(bot, {
      projectId: project.id,
      title: "before",
    });
    published = [];
    const issuesBefore = service.listItems(bot, { product: project.id });
    const issueBefore = service.getItem(bot, issue.id);
    const eventsBefore = allActivity();

    const writes = {
      createIssue: () =>
        service.createIssue(bot, { projectId: project.id, title: "after" }),
      updateIssue: () =>
        service.updateItem(bot, issue.id, { title: "after", status: "done" }),
      addComment: () =>
        service.addComment(bot, { issueId: issue.id, body: "after" }),
    };

    rejectEvents();
    for (const write of Object.values(writes)) {
      expect(write).toThrow("event rejected");
    }
    expect(service.listItems(bot, { product: project.id })).toEqual(
      issuesBefore,
    );
    expect(service.getItem(bot, issue.id)).toEqual(issueBefore);
    expect(service.listComments(bot, issue.id).items).toEqual([]);
    expect(allActivity()).toEqual(eventsBefore);
    expect(published).toEqual([]);

    allowEvents();
    for (const write of Object.values(writes)) write();
    const issuesAfter = service.listItems(bot, { product: project.id });
    expect(issuesAfter.items).toHaveLength(2);
    expect(service.getItem(bot, issue.id)).toMatchObject({
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
    () =>
      service.createProduct(bot, {
        key: projectKey(),
        name: "paged",
        owner: null,
      }),
  ]) as [Product];
  const issues = atFakeTime(
    titles.map(
      (title) => () => service.createIssue(bot, { projectId: paged.id, title }),
    ),
  );
  atFakeTime([
    () => service.updateItem(bot, issues[1]?.id ?? "", { status: "done" }),
    () => service.updateItem(bot, issues[2]?.id ?? "", { assigneeId: bot.id }),
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
      service.listItems(bot, { product: paged.id, cursor, limit: 2 }),
    );
    expect(pages).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
  });

  test("rows sharing a millisecond each land on exactly one page", () => {
    const tied = service.createProduct(bot, {
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
      service.listItems(bot, { product: tied.id, cursor, limit: 1 }),
    );
    expect(pages.flat().sort()).toEqual([...ids].sort());
  });

  test("issues filter by status and assignee", () => {
    expect(
      service
        .listItems(bot, { product: paged.id, status: "done" })
        .items.map((i) => i.title),
    ).toEqual(["two"]);
    expect(
      service
        .listItems(bot, { product: paged.id, assignee: bot.id })
        .items.map((i) => i.title),
    ).toEqual(["three"]);
  });

  test("activity pages newest first, filtered by project and actor", () => {
    const all = service.listActivity(bot, { product: paged.id }).items;
    expect(all.map((e) => e.action)).toEqual([
      "issue.updated",
      "issue.updated",
      ...titles.map(() => "issue.created"),
      "product.created",
    ]);
    const pages = walk((cursor) =>
      service.listActivity(bot, { product: paged.id, cursor, limit: 3 }),
    );
    expect(pages.flat()).toEqual(all.map((e) => e.id));
    expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
  });

  test("activity filters by actor within a project", () => {
    const shared = service.createProduct(bot, {
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
        .listActivity(bot, { product: shared.id, actorId })
        .items.map((e) => e.action);
    expect(mine(human.id)).toEqual(["issue.created"]);
    expect(mine(bot.id)).toEqual(["product.created"]);
    expect(filed?.createdBy).toBe(human.id);
  });

  test("a result that is an exact multiple of the limit ends without an empty page", () => {
    const exact = service.createProduct(bot, {
      key: projectKey(),
      name: "exact",
    });
    const ids = atFakeTime(
      ["a", "b", "c", "d"].map(
        (title) => () =>
          service.createIssue(bot, { projectId: exact.id, title }).id,
      ),
    ).reverse();
    const first = service.listItems(bot, { product: exact.id, limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = service.listItems(bot, {
      product: exact.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  test("an empty list is one page with no cursor", () => {
    const empty = service.createProduct(bot, {
      key: projectKey(),
      name: "empty",
    });
    expect(service.listItems(bot, { product: empty.id })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("activity rows sharing a millisecond each land on exactly one page", () => {
    const tied = service.createProduct(bot, {
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
        service.listActivity(bot, { product: tied.id, cursor, limit: 1 }),
      (event) => event.subjectId,
    );
    expect(pages).toHaveLength(subjects.length);
    expect(pages.flat().sort()).toEqual([...subjects].sort());
  });

  test("comments sharing a millisecond each land on exactly one page", () => {
    const own = service.createProduct(bot, {
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
    const own = service.createProduct(bot, {
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
      expect(() => service.listItems(bot, { cursor })).toThrow(ValidationError);
      expect(() => service.listActivity(bot, { cursor })).toThrow(
        ValidationError,
      );
    }
    for (const limit of [0, 201, 1.5]) {
      expect(() => service.listItems(bot, { limit })).toThrow(ValidationError);
    }
  });

  test("listing comments of an unknown issue is a NotFoundError", () => {
    expect(() => service.listComments(bot, "missing")).toThrow(NotFoundError);
  });
});

test("whoami is the calling actor's row, label included", () => {
  const labelled = createBot(db, "whoami bot", { label: "agent-whoami" }).actor;
  expect(service.whoami(labelled)).toEqual({
    ...labelled,
    photoUrl: null,
    unreadMessages: 0,
    team: null,
    hint: expect.stringContaining("create_team"),
    ownProducts: [],
    impliedProjects: [],
    products: service
      .listProducts(labelled, { limit: 200 })
      .items.map(whole)
      .map(({ owner, ...row }) => row)
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  });
  expect(service.whoami(human)).toMatchObject({
    id: human.id,
    kind: "human",
    displayName: "Pat",
    label: null,
  });
});

test("listBots pages every bot oldest first, never a human", () => {
  const [first, labelled] = atFakeTime([
    () => createBot(db, "listed first").actor,
    () => createBot(db, "listed bot", { label: "agent-listed" }).actor,
  ]) as [typeof bot, typeof bot];
  const all = [];
  let cursor: string | undefined;
  do {
    const page = service.listBots(human, { cursor, limit: 1 });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(all.every((a) => a.kind === "bot")).toBe(true);
  const ids = all.map((a) => a.id);
  expect(ids.indexOf(first.id)).toBe(0);
  expect(ids.indexOf(labelled.id)).toBe(1);
  expect(all[1]).toEqual({ ...labelled, photoUrl: null });
  expect(ids).toContain(bot.id);
});

describe("a page of projects or products", () => {
  /** How many statements `read` prepares on the database connection. */
  function statementsOf(read: () => unknown): number {
    const prepare = vi.spyOn(db.$client, "prepare");
    try {
      read();
      return prepare.mock.calls.length;
    } finally {
      prepare.mockRestore();
    }
  }

  test("is read in as many statements for 50 rows as for 5", () => {
    const lead = createBot(db, "batched lead").actor;
    for (let n = 0; n < 50; n++) {
      const owned = service.createProduct(lead, {
        key: projectKey(),
        name: `batched ${n}`,
      });
      service.createProject(lead, {
        name: `batched ${n}`,
        products: [owned.key],
      });
      service.addTodo(lead, { product: owned.key, title: `todo ${n}` });
      if (n % 2 === 0) {
        service.createStatusUpdate(lead, {
          project: `batched-${n}`,
          body: "going",
          health: "on_track",
        });
      }
    }
    const projects = (limit: number) =>
      statementsOf(() => {
        const page = service.listProjects(lead, { limit });
        expect(page.items).toHaveLength(limit);
        expect(page.items.some((p) => p.latestStatusUpdate !== null)).toBe(
          true,
        );
      });
    const products = (limit: number) =>
      statementsOf(() => {
        const page = service.listProducts(lead, { limit });
        expect(page.items).toHaveLength(limit);
        expect(page.items.map(whole)[0]?.owner?.name).toBe("batched lead");
      });
    expect(projects(50)).toBe(projects(5));
    expect(products(50)).toBe(products(5));
  });
});
