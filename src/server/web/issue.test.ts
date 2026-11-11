import { expect, test } from "vitest";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { request, signIn, owner, addProject, addBot, bot } = setupTestApp();
const ownerCookie = await signIn(owner);

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

async function get(path: string) {
  const res = await request("GET", `/api/web${path}`, {
    key: null,
    cookie: ownerCookie,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const v1 = (method: string, path: string, json?: unknown, key?: string) =>
  request(method, `/api/v1${path}`, { json, key });

const tester = { id: bot.actor.id, name: "tester", kind: "bot" };

test("an issue reads with its fields, its people as actors, and a timeline oldest first with one entry per changed field", async () => {
  const p = addProject("Detail");
  const worker = addBot("worker");
  const [created] = await atFakeTimeAsync([
    () =>
      v1("POST", "/issues", {
        projectId: p.id,
        title: "Fix it",
        description: "details",
        labels: ["bug"],
        links: [{ url: "https://example.com/1", title: "one" }],
      }),
  ]);
  const { id } = (await (created as Response).json()) as { id: string };
  await atFakeTimeAsync([
    () =>
      v1("PATCH", `/issues/${id}`, {
        status: "in_progress",
        priority: 2,
        assigneeId: worker.actor.id,
        estimate: 3,
      }),
    () => v1("POST", `/issues/${id}/comments`, { body: "on it" }, worker.key),
    () =>
      v1("PATCH", `/issues/${id}`, {
        addLabels: ["ui"],
        removeLabels: ["bug"],
        addLinks: [{ url: "https://example.com/2", title: "two" }],
        assigneeId: null,
        estimate: null,
      }),
    // neither a removed link nor a renamed title is a timeline entry
    () =>
      v1("PATCH", `/issues/${id}`, {
        title: "Fix it now",
        removeLinks: ["https://example.com/1"],
      }),
  ]);

  const { status, body } = await get(`/issues/${p.key}-1`);
  expect(status).toBe(200);
  const { timeline, ...fields } = body;
  expect(fields).toEqual({
    key: `${p.key}-1`,
    sourceKey: null,
    project: { key: p.key, name: "Detail" },
    title: "Fix it now",
    description: "details",
    status: "in_progress",
    priority: 2,
    estimate: null,
    labels: ["ui"],
    links: [{ url: "https://example.com/2", title: "two" }],
    assignee: null,
    creator: tester,
    sourceAuthor: null,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    completedAt: null,
  });
  const workerActor = { id: worker.actor.id, name: "worker", kind: "bot" };
  const issue = { key: `${p.key}-1`, title: "Fix it now" };
  const project = { key: p.key, name: "Detail" };
  expect(
    timeline.map(({ id: _, createdAt: __, ...rest }: Body) => rest),
  ).toEqual([
    {
      kind: "issue_created",
      actor: tester,
      project,
      issue,
      sourceAuthor: null,
    },
    {
      kind: "status_changed",
      actor: tester,
      project,
      issue,
      from: "open",
      to: "in_progress",
    },
    { kind: "priority_changed", actor: tester, project, issue, from: 0, to: 2 },
    {
      kind: "assignee_changed",
      actor: tester,
      project,
      issue,
      from: null,
      to: workerActor,
    },
    {
      kind: "estimate_changed",
      actor: tester,
      project,
      issue,
      from: null,
      to: 3,
    },
    {
      kind: "comment",
      actor: workerActor,
      project,
      issue,
      comment: { id: expect.any(String), body: "on it", sourceAuthor: null },
    },
    {
      kind: "labels_changed",
      actor: tester,
      project,
      issue,
      added: ["ui"],
      removed: ["bug"],
    },
    {
      kind: "link_added",
      actor: tester,
      project,
      issue,
      link: { url: "https://example.com/2", title: "two" },
    },
    {
      kind: "assignee_changed",
      actor: tester,
      project,
      issue,
      from: workerActor,
      to: null,
    },
    {
      kind: "estimate_changed",
      actor: tester,
      project,
      issue,
      from: 3,
      to: null,
    },
  ]);
  expect(new Set(timeline.map((e: Body) => e.id)).size).toBe(timeline.length);
});

test("an imported issue is found by its source key and credits the importing bot, with the source authors beside it", async () => {
  const importer = addBot("importer");
  const res = await v1(
    "POST",
    "/import",
    {
      externalRef: "proj-alias",
      key: "ALIAS",
      name: "Alias",
      issues: [
        {
          externalRef: "iss-1",
          sourceKey: "JUS-187",
          title: "From Linear",
          status: "Todo",
          createdAt: "2026-01-02T03:04:05.000Z",
          sourceAuthor: "Jane",
          comments: [
            {
              externalRef: "c-1",
              body: "imported comment",
              createdAt: "2026-01-03T03:04:05.000Z",
              sourceAuthor: "Joe",
            },
          ],
        },
      ],
    },
    importer.key,
  );
  expect(res.status).toBe(200);

  const { status, body } = await get("/issues/jus-187");
  expect(status).toBe(200);
  const importerActor = {
    id: importer.actor.id,
    name: "importer",
    kind: "bot",
  };
  expect(body).toMatchObject({
    key: "ALIAS-1",
    sourceKey: "JUS-187",
    creator: importerActor,
    sourceAuthor: "Jane",
  });
  expect(body.timeline).toMatchObject([
    {
      kind: "issue_created",
      actor: importerActor,
      sourceAuthor: "Jane",
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    {
      kind: "comment",
      actor: importerActor,
      comment: { body: "imported comment", sourceAuthor: "Joe" },
    },
  ]);
});
