import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { createEventBus } from "../events/bus.js";
import { atFakeTime, projectKey, testWebhooks } from "../test-app.js";
import {
  createService,
  type ImportComment,
  type ImportIssue,
  type ImportPayload,
  type ImportStatusUpdate,
} from "./index.js";
import { createBot } from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-import-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = createService({
  db,
  bus: createEventBus(),
  webhooks: testWebhooks,
});
const bot = createBot(db, "migrator").actor;

let refs = 0;
/** A Linear-shaped project: 3 issues, 2 comments, a status update, labels and a PR link. */
function linearProject(): ImportPayload {
  const ref = `P-${++refs}`;
  return {
    externalRef: ref,
    key: projectKey(),
    name: "Migrated",
    description: "from Linear",
    labels: ["Bug"],
    issues: [
      {
        externalRef: `${ref}-i1`,
        title: "first",
        status: "Todo",
        priority: 2,
        estimate: 3,
        labels: ["Bug", "Backend"],
        links: [{ url: "https://github.com/o/r/pull/1", title: "PR 1" }],
        createdAt: "2026-01-02T03:04:05.000Z",
        sourceAuthor: "Ada",
        comments: [
          {
            externalRef: `${ref}-c1`,
            body: "looks right",
            createdAt: "2026-01-03T00:00:00.000Z",
            sourceAuthor: "Grace",
          },
          {
            externalRef: `${ref}-c2`,
            body: "merged",
            createdAt: "2026-01-04T00:00:00.000Z",
          },
        ],
      },
      {
        externalRef: `${ref}-i2`,
        title: "second",
        status: "Done",
        createdAt: "2026-01-05T00:00:00.000Z",
        completedAt: "2026-01-06T00:00:00.000Z",
      },
      {
        externalRef: `${ref}-i3`,
        title: "third",
        status: "In Progress",
        createdAt: "2026-01-07T00:00:00.000Z",
      },
    ],
    statusUpdates: [
      {
        externalRef: `${ref}-u1`,
        body: "on schedule",
        health: "on_track",
        createdAt: "2026-01-08T00:00:00.000Z",
        sourceAuthor: "Ada",
      },
    ],
  };
}

const zero = {
  projects: 0,
  issues: 0,
  comments: 0,
  labels: 0,
  links: 0,
  statusUpdates: 0,
};

test("a first import creates every row and counts each kind as created", () => {
  const payload = linearProject();
  const result = service.importProject(bot, payload);
  expect(result.project).toMatchObject({
    key: payload.key,
    name: "Migrated",
    externalRef: payload.externalRef,
    createdBy: bot.id,
  });
  expect(result.created).toEqual({
    projects: 1,
    issues: 3,
    comments: 2,
    labels: 2,
    links: 1,
    statusUpdates: 1,
  });
  expect(result.updated).toEqual(zero);
  expect(result.unchanged).toEqual(zero);

  const issues = service.listIssues(bot, { projectId: payload.key }).items;
  expect(
    issues
      .map((i) => [i.key, i.title, i.status])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    [`${payload.key}-1`, "first", "open"],
    [`${payload.key}-2`, "second", "done"],
    [`${payload.key}-3`, "third", "in_progress"],
  ]);
});

/** Rows per table, so a re-run can be checked for duplicates. */
function rowCounts() {
  const count = (table: string) =>
    (
      db.$client.prepare(`select count(*) as n from ${table}`).get() as {
        n: number;
      }
    ).n;
  return Object.fromEntries(
    [
      "project",
      "issue",
      "comment",
      "label",
      "issue_label",
      "issue_link",
      "project_status_update",
      "activity_event",
    ].map((t) => [t, count(t)]),
  );
}

test("re-running an import creates nothing, counts every row unchanged and writes nothing", () => {
  const payload = linearProject();
  const first = service.importProject(bot, payload);
  const before = rowCounts();
  const issuesBefore = service.listIssues(bot, { projectId: payload.key });

  const second = service.importProject(bot, payload);
  expect(second.created).toEqual(zero);
  expect(second.updated).toEqual(zero);
  expect(second.unchanged).toEqual(first.created);
  expect(rowCounts()).toEqual(before);
  expect(second.project).toEqual(first.project);
  expect(service.listIssues(bot, { projectId: payload.key })).toEqual(
    issuesBefore,
  );
});

test("a re-run with one changed field per kind counts those rows updated and the rest unchanged", () => {
  const payload = linearProject();
  // on the fake clock an hour back, so the re-run's writes are visibly later
  atFakeTime([() => service.importProject(bot, payload)]);
  const [i1, i2, i3] = payload.issues ?? [];
  const before = service.getIssue(bot, `${payload.key}-2`);
  const untouched = service.getIssue(bot, `${payload.key}-3`);

  const changed: ImportPayload = {
    ...payload,
    name: "Renamed",
    issues: [
      {
        ...(i1 as ImportIssue),
        links: [{ url: "https://github.com/o/r/pull/1", title: "PR one" }],
        comments: [
          { ...(i1?.comments?.[0] as ImportComment), body: "edited" },
          i1?.comments?.[1] as ImportComment,
        ],
      },
      { ...(i2 as ImportIssue), title: "second, retitled" },
      i3 as ImportIssue,
    ],
    statusUpdates: [
      {
        ...(payload.statusUpdates?.[0] as ImportStatusUpdate),
        health: "at_risk",
      },
    ],
  };
  const result = service.importProject(bot, changed);
  expect(result.created).toEqual(zero);
  expect(result.updated).toEqual({
    projects: 1,
    issues: 2,
    comments: 1,
    labels: 0,
    links: 1,
    statusUpdates: 1,
  });
  expect(result.unchanged).toEqual({
    projects: 0,
    issues: 1,
    comments: 1,
    labels: 2,
    links: 0,
    statusUpdates: 0,
  });
  const after = service.getIssue(bot, `${payload.key}-2`);
  expect(after.title).toBe("second, retitled");
  expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  expect(after.number).toBe(before.number);
  expect(service.getIssue(bot, `${payload.key}-3`)).toEqual(untouched);
  expect(service.getProject(bot, payload.key).name).toBe("Renamed");
  expect(
    service.listComments(bot, `${payload.key}-1`).items.map((c) => c.body),
  ).toEqual(["edited", "merged"]);
});

test("imported rows keep their source createdAt, completedAt and author, credited to the importing bot", () => {
  const payload = linearProject();
  service.importProject(bot, payload);
  const first = service.getIssue(bot, `${payload.key}-1`);
  expect(first).toMatchObject({
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    completedAt: null,
    sourceAuthor: "Ada",
    createdBy: bot.id,
    priority: 2,
    estimate: 3,
    labels: ["Backend", "Bug"],
    links: [{ url: "https://github.com/o/r/pull/1", title: "PR 1" }],
  });
  expect(service.getIssue(bot, `${payload.key}-2`)).toMatchObject({
    status: "done",
    completedAt: new Date("2026-01-06T00:00:00.000Z"),
    sourceAuthor: null,
  });
  expect(service.listComments(bot, first.id).items).toMatchObject([
    {
      body: "looks right",
      authorId: bot.id,
      sourceAuthor: "Grace",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    },
    { body: "merged", authorId: bot.id, sourceAuthor: null },
  ]);
  expect(service.listStatusUpdates(bot, payload.key).items).toMatchObject([
    {
      body: "on schedule",
      health: "on_track",
      authorId: bot.id,
      sourceAuthor: "Ada",
      createdAt: new Date("2026-01-08T00:00:00.000Z"),
    },
  ]);
});

test("an import writes one project.imported event with the counts; a run that changes nothing writes none", () => {
  const payload = linearProject();
  const projectEvents = (projectId: string) =>
    service.listActivity(bot, { projectId, limit: 200 }).items;

  const first = service.importProject(bot, payload);
  expect(projectEvents(first.project.id)).toMatchObject([
    {
      action: "project.imported",
      actorId: bot.id,
      subjectType: "project",
      subjectId: first.project.id,
      payload: {
        externalRef: payload.externalRef,
        created: first.created,
        updated: zero,
        unchanged: zero,
      },
    },
  ]);

  service.importProject(bot, payload);
  expect(projectEvents(first.project.id)).toHaveLength(1);

  const third = service.importProject(bot, { ...payload, name: "Renamed" });
  const events = projectEvents(first.project.id);
  expect(events).toHaveLength(2);
  expect(events[0]?.payload).toMatchObject({
    updated: { ...zero, projects: 1 },
    unchanged: third.unchanged,
  });
});

test("a second bot re-importing updates rows in place: the first stays their creator, the second is credited with the update", () => {
  const second = createBot(db, "second migrator").actor;
  const payload = linearProject();
  atFakeTime([() => service.importProject(bot, payload)]);
  const before = rowCounts();
  const issuesBefore = service.listIssues(bot, {
    projectId: payload.key,
  }).items;
  const [i1, ...rest] = payload.issues ?? [];

  const result = service.importProject(second, {
    ...payload,
    issues: [{ ...(i1 as ImportIssue), title: "first, retitled" }, ...rest],
  });
  expect(result.created).toEqual(zero);
  expect(result.updated).toEqual({ ...zero, issues: 1 });
  expect(rowCounts()).toEqual({
    ...before,
    activity_event: (before.activity_event as number) + 1,
  });

  const issuesAfter = service.listIssues(bot, { projectId: payload.key }).items;
  expect(issuesAfter.map((i) => i.createdBy)).toEqual(
    issuesBefore.map(() => bot.id),
  );
  const retitled = (list: typeof issuesAfter) =>
    list.find((i) => i.externalRef === i1?.externalRef);
  expect(retitled(issuesAfter)?.updatedAt.getTime()).toBeGreaterThan(
    retitled(issuesBefore)?.updatedAt.getTime() as number,
  );
  const untouched = (list: typeof issuesAfter) =>
    list.filter((i) => i.externalRef !== i1?.externalRef);
  expect(untouched(issuesAfter)).toEqual(untouched(issuesBefore));
  expect(result.project.createdBy).toBe(bot.id);
  expect(
    service.listComments(bot, `${payload.key}-1`).items.map((c) => c.authorId),
  ).toEqual([bot.id, bot.id]);

  const [latest] = service.listActivity(bot, {
    projectId: result.project.id,
  }).items;
  expect(latest).toMatchObject({
    action: "project.imported",
    actorId: second.id,
  });
});

test("a closed issue imported without completedAt is stamped once and keeps that stamp on re-runs", () => {
  const payload = linearProject();
  payload.issues = [
    {
      externalRef: `${payload.externalRef}-dup`,
      title: "dup",
      status: "Duplicate",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  service.importProject(bot, payload);
  const stamped = service.getIssue(bot, `${payload.key}-1`).completedAt;
  expect(stamped).toBeInstanceOf(Date);
  expect(service.importProject(bot, payload).unchanged.issues).toBe(1);
  expect(service.getIssue(bot, `${payload.key}-1`).completedAt).toEqual(
    stamped,
  );
});

const oneIssue = (issue: Partial<ImportIssue>): ImportPayload => ({
  ...linearProject(),
  issues: [
    {
      externalRef: "only",
      title: "only",
      status: "Todo",
      createdAt: "2026-01-02T00:00:00.000Z",
      ...issue,
    },
  ],
});

test.each([
  ["Backlog", "open"],
  ["Todo", "open"],
  ["In Progress", "in_progress"],
  ["Done", "done"],
  ["Canceled", "canceled"],
  ["Duplicate", "canceled"],
  ["Triage", "open"],
  ["in progress", "in_progress"],
  ["BACKLOG", "open"],
  ["in_progress", "in_progress"],
  ["canceled", "canceled"],
])("source status %s imports as %s", (status, expected) => {
  const payload = oneIssue({ status });
  service.importProject(bot, payload);
  expect(service.getIssue(bot, `${payload.key}-1`).status).toBe(expected);
});

test("a custom state name with a statusType imports by the type and keeps the name as sourceStatus", () => {
  const payload = oneIssue({ status: "In Review", statusType: "started" });
  service.importProject(bot, payload);
  expect(service.getIssue(bot, `${payload.key}-1`)).toMatchObject({
    status: "in_progress",
    sourceStatus: "In Review",
  });
});

test("a trail edit of an imported issue, status change included, leaves sourceStatus as imported", () => {
  const payload = oneIssue({ status: "In Review", statusType: "started" });
  service.importProject(bot, payload);
  const key = `${payload.key}-1`;

  service.updateIssue(bot, key, { title: "retitled" });
  expect(service.getIssue(bot, key)).toMatchObject({
    title: "retitled",
    sourceStatus: "In Review",
  });
  service.updateIssue(bot, key, { status: "done" });
  expect(service.getIssue(bot, key)).toMatchObject({
    status: "done",
    sourceStatus: "In Review",
  });
});

/** Checks `payload` is refused with `message` and nothing is written. */
function refused(payload: ImportPayload, message: RegExp | string) {
  const before = rowCounts();
  expect(() => service.importProject(bot, payload)).toThrow(message);
  expect(rowCounts()).toEqual(before);
}

test("a status name that maps to nothing, with no statusType, is refused, telling the bot to send statusType", () => {
  refused(
    oneIssue({ status: "In Review" }),
    'issue only: status "In Review" has no mapping: send statusType too (Linear\'s state.type: backlog, unstarted, triage, started, completed, canceled, duplicate), or a status of Backlog, Todo, Triage, In Progress, Done, Canceled, Duplicate (any case) or a trail status: open, in_progress, done, canceled',
  );
});

test.each([
  ["backlog", "open"],
  ["unstarted", "open"],
  ["triage", "open"],
  ["started", "in_progress"],
  ["completed", "done"],
  ["canceled", "canceled"],
  ["duplicate", "canceled"],
  ["STARTED", "in_progress"],
])(
  "statusType %s imports as %s, whatever the name says",
  (statusType, expected) => {
    const payload = oneIssue({ status: "Todo", statusType });
    service.importProject(bot, payload);
    expect(service.getIssue(bot, `${payload.key}-1`)).toMatchObject({
      status: expected,
      sourceStatus: "Todo",
    });
  },
);

test("a statusType alone decides the status and leaves sourceStatus null", () => {
  const payload = oneIssue({ status: undefined, statusType: "completed" });
  service.importProject(bot, payload);
  expect(service.getIssue(bot, `${payload.key}-1`)).toMatchObject({
    status: "done",
    sourceStatus: null,
  });
});

test("an unknown statusType is refused, listing the accepted types", () => {
  refused(
    oneIssue({ status: "In Review", statusType: "reviewing" }),
    'issue only: statusType "reviewing" is not a state type: send one of backlog, unstarted, triage, started, completed, canceled, duplicate (any case), Linear\'s state.type',
  );
});

test("an issue with neither status nor statusType is refused, saying to send them", () => {
  refused(
    oneIssue({ status: undefined }),
    "issue only has neither status nor statusType: send statusType (Linear's state.type, like started) and status (the state's name, like In Review)",
  );
});

test("a re-run leaves an unchanged sourceStatus alone and counts a renamed state as updated", () => {
  const payload = oneIssue({ status: "In Review", statusType: "started" });
  atFakeTime([() => service.importProject(bot, payload)]);
  const before = service.getIssue(bot, `${payload.key}-1`);

  expect(service.importProject(bot, payload).unchanged.issues).toBe(1);
  expect(service.getIssue(bot, `${payload.key}-1`)).toEqual(before);

  const renamed = oneIssue({ status: "Code Review", statusType: "started" });
  const result = service.importProject(bot, {
    ...payload,
    issues: renamed.issues,
  });
  expect(result.updated.issues).toBe(1);
  const after = service.getIssue(bot, `${payload.key}-1`);
  expect(after).toMatchObject({
    status: "in_progress",
    sourceStatus: "Code Review",
  });
  expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
});

test("a re-run that sends only statusType clears the previous sourceStatus", () => {
  const payload = oneIssue({ status: "In Review", statusType: "started" });
  service.importProject(bot, payload);

  const typeOnly = oneIssue({ status: undefined, statusType: "started" });
  const result = service.importProject(bot, {
    ...payload,
    issues: typeOnly.issues,
  });
  expect(result.updated.issues).toBe(1);
  expect(service.getIssue(bot, `${payload.key}-1`)).toMatchObject({
    status: "in_progress",
    sourceStatus: null,
  });
});

test("a re-run moving statusType from started to completed closes the issue, stamped once", () => {
  const payload = oneIssue({ status: "In Review", statusType: "started" });
  service.importProject(bot, payload);
  expect(service.getIssue(bot, `${payload.key}-1`).completedAt).toBeNull();

  const closed = {
    ...payload,
    issues: oneIssue({ status: undefined, statusType: "completed" }).issues,
  };
  expect(service.importProject(bot, closed).updated.issues).toBe(1);
  const done = service.getIssue(bot, `${payload.key}-1`);
  expect(done).toMatchObject({ status: "done", sourceStatus: null });
  expect(done.completedAt).toBeInstanceOf(Date);

  expect(service.importProject(bot, closed).unchanged.issues).toBe(1);
  expect(service.getIssue(bot, `${payload.key}-1`).completedAt).toEqual(
    done.completedAt,
  );
});

test("a completedAt on an open issue is refused", () => {
  refused(
    oneIssue({ status: "Todo", completedAt: "2026-01-03T00:00:00.000Z" }),
    /^issue only is open \(from "Todo"\) but has a completedAt/,
  );
});

test("a payload listing an externalRef twice in one scope is refused, naming it", () => {
  const payload = linearProject();
  const [i1] = payload.issues ?? [];
  refused(
    { ...payload, issues: [i1 as ImportIssue, { ...(i1 as ImportIssue) }] },
    `issues lists externalRef ${i1?.externalRef} twice`,
  );
  const c1 = i1?.comments?.[0] as ImportComment;
  refused(
    { ...payload, issues: [{ ...(i1 as ImportIssue), comments: [c1, c1] }] },
    `issue ${i1?.externalRef} comments lists externalRef ${c1.externalRef} twice`,
  );
  const u1 = payload.statusUpdates?.[0] as ImportStatusUpdate;
  refused(
    { ...payload, statusUpdates: [u1, u1] },
    `statusUpdates lists externalRef ${u1.externalRef} twice`,
  );
});

test("a new project whose key another project holds is a conflict; a project's key never changes", () => {
  const holder = linearProject();
  service.importProject(bot, holder);
  refused(
    { ...linearProject(), key: holder.key },
    `project key ${holder.key} is taken`,
  );
  refused(
    { ...holder, key: projectKey() },
    `project ${holder.externalRef} was imported with key ${holder.key}: send key ${holder.key}`,
  );
});

const todo = (externalRef: string, createdAt = "2026-02-01T00:00:00.000Z") =>
  ({
    externalRef,
    title: externalRef,
    status: "Todo",
    createdAt,
  }) satisfies ImportIssue;

test("label names in one payload match across ASCII case only, as on later runs", () => {
  const payload = {
    ...linearProject(),
    labels: ["Foo"],
    issues: [
      { ...todo("i-1"), labels: ["foo", "Équipe", "équipe"] },
      { ...todo("i-2"), labels: ["ÉQUIPE"] },
    ],
  } satisfies ImportPayload;
  expect(service.importProject(bot, payload).created.labels).toBe(3);
  const labelsOf = (title: string) =>
    service
      .listIssues(bot, { projectId: payload.key })
      .items.find((i) => i.title === title)?.labels;
  expect(labelsOf("i-1")).toEqual(["Foo", "Équipe", "équipe"]);
  expect(labelsOf("i-2")).toEqual(["Équipe"]);
  expect(service.importProject(bot, payload).unchanged.labels).toBe(3);
});

test.each([
  ["as sorted", [0, 1, 2, 3]],
  ["reversed", [3, 2, 1, 0]],
  ["shuffled", [2, 0, 3, 1]],
])(
  "new issues are numbered by createdAt then externalRef after the project's existing ones, whatever the payload order (%s)",
  (_, order) => {
    const payload = linearProject();
    service.importProject(bot, payload);
    service.createIssue(bot, { projectId: payload.key, title: "by hand" });
    const added = [
      todo("new-z", "2026-02-01T00:00:00.000Z"),
      todo("new-a", "2026-02-02T00:00:00.000Z"),
      todo("new-b", "2026-02-02T00:00:00.000Z"),
      todo("new-c", "2026-02-03T00:00:00.000Z"),
    ];
    service.importProject(bot, {
      ...payload,
      issues: [
        ...(payload.issues ?? []),
        ...order.map((i) => added[i] as ImportIssue),
      ],
    });
    const keyOf = (title: string) =>
      service
        .listIssues(bot, { projectId: payload.key })
        .items.find((i) => i.title === title)?.key;
    expect(
      ["first", "by hand", "new-z", "new-a", "new-b", "new-c"].map(keyOf),
    ).toEqual([1, 4, 5, 6, 7, 8].map((n) => `${payload.key}-${n}`));
  },
);

test("an issue whose externalRef is the project's own key keeps that number, and the sequence moves past it", () => {
  const payload: ImportPayload = {
    externalRef: "linear-JUS",
    key: "JUS",
    name: "Justin",
    issues: [todo("JUS-187"), todo("JUS-1"), todo("from-elsewhere")],
  };
  service.importProject(bot, payload);
  expect(service.getIssue(bot, "JUS-187").externalRef).toBe("JUS-187");
  expect(service.getIssue(bot, "JUS-1").externalRef).toBe("JUS-1");
  expect(service.getIssue(bot, "JUS-188").externalRef).toBe("from-elsewhere");
  expect(
    service.createIssue(bot, { projectId: "JUS", title: "by hand" }).key,
  ).toBe("JUS-189");

  const rerun = service.importProject(bot, payload);
  expect(rerun.created).toEqual(zero);
  expect(rerun.unchanged.issues).toBe(3);
});

test("createIssue numbers past the highest kept number, across re-imports and a later import keeping a higher one", () => {
  const key = projectKey();
  const payload: ImportPayload = {
    externalRef: `linear-${key}`,
    key,
    name: "kept numbers",
    issues: [todo(`${key}-12`), todo("elsewhere-1")],
  };
  const nextKey = () =>
    service.createIssue(bot, { projectId: key, title: "by hand" }).key;

  service.importProject(bot, payload);
  expect(service.getIssue(bot, `${key}-13`).externalRef).toBe("elsewhere-1");
  expect(nextKey()).toBe(`${key}-14`);

  service.importProject(bot, payload);
  expect(nextKey()).toBe(`${key}-15`);

  service.importProject(bot, {
    ...payload,
    issues: [...(payload.issues ?? []), todo(`${key}-187`), todo(`${key}-3`)],
  });
  expect(nextKey()).toBe(`${key}-188`);
  expect(service.getIssue(bot, `${key}-3`).externalRef).toBe(`${key}-3`);
});

test("an issue keeping a number another issue holds takes the next number, and the result lists it", () => {
  const payload = linearProject();
  service.importProject(bot, payload);
  const holder = service.createIssue(bot, {
    projectId: payload.key,
    title: "by hand",
  });
  const result = service.importProject(bot, {
    ...payload,
    issues: [todo("brand-new"), todo(holder.key)],
  });
  const next = holder.number + 1;
  expect(result.renumbered).toEqual([
    { externalRef: holder.key, sourceKey: null, key: `${payload.key}-${next}` },
  ]);
  expect(service.getIssue(bot, holder.id).title).toBe("by hand");
  expect(service.getIssue(bot, `${payload.key}-${next}`).externalRef).toBe(
    holder.key,
  );
});

const linearIssue = (uuid: string, sourceKey?: string) =>
  ({
    ...todo(uuid),
    ...(sourceKey === undefined ? {} : { sourceKey }),
  }) satisfies ImportIssue;

test("issues sent with Linear UUIDs as externalRef keep the number of a sourceKey in the project's key", () => {
  const key = projectKey();
  service.importProject(bot, {
    externalRef: `linear-${key}`,
    key,
    name: "by uuid",
    issues: [
      linearIssue("8f1c0f4e-0000-4000-8000-000000000187", `${key}-187`),
      linearIssue("8f1c0f4e-0000-4000-8000-000000000012", `${key}-12`),
    ],
  });
  expect(service.getIssue(bot, `${key}-187`).externalRef).toBe(
    "8f1c0f4e-0000-4000-8000-000000000187",
  );
  expect(service.getIssue(bot, `${key}-12`).externalRef).toBe(
    "8f1c0f4e-0000-4000-8000-000000000012",
  );
});

test("a sourceKey under another project's key gets the next number, even beside a key-form externalRef", () => {
  const key = projectKey();
  service.importProject(bot, {
    externalRef: `linear-${key}`,
    key,
    name: "moved team",
    issues: [
      linearIssue("uuid-kept", `${key}-40`),
      linearIssue("uuid-moved", "OTHER-7"),
      linearIssue(`${key}-90`, "OTHER-8"),
    ],
  });
  // the sequenced two tie on createdAt, so externalRef orders them
  expect(service.getIssue(bot, `${key}-41`).externalRef).toBe(`${key}-90`);
  expect(service.getIssue(bot, `${key}-42`).externalRef).toBe("uuid-moved");
});

test("without a sourceKey, a key-form externalRef still keeps its number", () => {
  const key = projectKey();
  service.importProject(bot, {
    externalRef: `linear-${key}`,
    key,
    name: "old payload",
    issues: [linearIssue(`${key}-9`)],
  });
  expect(service.getIssue(bot, `${key}-9`).externalRef).toBe(`${key}-9`);
});

test("a re-run with a changed sourceKey leaves the matched issue's number alone, creates nothing and stores the new sourceKey", () => {
  const key = projectKey();
  const payload: ImportPayload = {
    externalRef: `linear-${key}`,
    key,
    name: "renumbered upstream",
    issues: [linearIssue("uuid-stays", `${key}-5`)],
  };
  service.importProject(bot, payload);
  const rerun = service.importProject(bot, {
    ...payload,
    issues: [linearIssue("uuid-stays", `${key}-77`)],
  });
  expect(rerun.created).toEqual(zero);
  expect(rerun.updated.issues).toBe(1);
  expect(service.getIssue(bot, `${key}-5`).externalRef).toBe("uuid-stays");
  expect(service.getIssue(bot, `${key}-5`).sourceKey).toBe(`${key}-77`);
  expect(service.getIssue(bot, `${key}-77`).key).toBe(`${key}-5`);
});

test("a sourceKey whose number another issue holds gets the next number and still finds the issue by its sourceKey", () => {
  const payload = linearProject();
  service.importProject(bot, payload);
  const holder = service.createIssue(bot, {
    projectId: payload.key,
    title: "by hand",
  });
  const result = service.importProject(bot, {
    ...payload,
    issues: [linearIssue("uuid-clash", holder.key)],
  });
  const key = `${payload.key}-${holder.number + 1}`;
  expect(result.renumbered).toEqual([
    { externalRef: "uuid-clash", sourceKey: holder.key, key },
  ]);
  // the trail key wins over the source key that looks the same
  expect(service.getIssue(bot, holder.key).id).toBe(holder.id);
  expect(service.getIssue(bot, key).sourceKey).toBe(holder.key);
});

test("re-running a payload that renumbered an issue matches it by externalRef, keeps its new number and lists nothing", () => {
  const payload = linearProject();
  service.importProject(bot, payload);
  const holder = service.createIssue(bot, {
    projectId: payload.key,
    title: "by hand",
  });
  const rerunnable: ImportPayload = {
    ...payload,
    issues: [...(payload.issues ?? []), linearIssue("uuid-late", holder.key)],
  };
  const first = service.importProject(bot, rerunnable);
  const newKey = `${payload.key}-${holder.number + 1}`;
  expect(first.renumbered).toEqual([
    { externalRef: "uuid-late", sourceKey: holder.key, key: newKey },
  ]);
  expect(first.created.issues).toBe(1);

  const again = service.importProject(bot, rerunnable);
  expect(again.renumbered).toEqual([]);
  expect(again.created).toEqual(zero);
  expect(again.updated).toEqual(zero);
  expect(again.unchanged.issues).toBe((payload.issues ?? []).length + 1);
  expect(service.getIssue(bot, newKey).externalRef).toBe("uuid-late");
  expect(service.getIssue(bot, holder.key).id).toBe(holder.id);
  expect(
    service.createIssue(bot, { projectId: payload.key, title: "n" }).number,
  ).toBe(holder.number + 2);
});

test("two payload issues keeping one number are refused, naming both, and nothing is written", () => {
  const key = projectKey();
  refused(
    {
      externalRef: `linear-${key}`,
      key,
      name: "collision",
      issues: [linearIssue("uuid-a", `${key}-5`), linearIssue(`${key}-5`)],
    },
    `issues uuid-a and ${key}-5 both keep number ${key}-5: send each issue its own sourceKey`,
  );
});

test("two issues sending one sourceKey are refused, naming both", () => {
  const payload = linearProject();
  refused(
    {
      ...payload,
      issues: [
        linearIssue("uuid-a", `${payload.key}-3`),
        linearIssue("uuid-b", `${payload.key}-3`.toLowerCase()),
      ],
    },
    /issues uuid-a and uuid-b both send sourceKey/,
  );
});

test("two new issues keeping one number are refused, naming both, and nothing is written", () => {
  const payload = linearProject();
  refused(
    {
      ...payload,
      issues: [
        linearIssue("uuid-a", `${payload.key}-3`),
        linearIssue(`${payload.key}-3`),
      ],
    },
    `issues uuid-a and ${payload.key}-3 both keep number ${payload.key}-3: send each issue its own sourceKey`,
  );
});

test("a sourceKey not shaped like an issue key is refused, naming it", () => {
  refused(
    { ...linearProject(), issues: [linearIssue("uuid-bad", "JUS187")] },
    'issue JUS187 (externalRef uuid-bad): sourceKey "JUS187" is not an issue key: send Linear\'s identifier, like JUS-187',
  );
});
