import { beforeAll, describe, expect, test } from "vitest";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { request, addMember, addProject, addBot } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const v1 = (method: string, path: string, json?: unknown, key?: string) =>
  request(method, `/api/v1${path}`, { json, key });

describe("GET /feed", () => {
  const visible = addProject("Visible");
  const hidden = addProject("Hidden");
  const loud = addBot("loud");
  const secret = addBot("secret");
  let cookie = "";
  let visibleIssue = "";

  async function file(projectId: string, title: string, key?: string) {
    const res = await v1("POST", "/issues", { projectId, title }, key);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    cookie = await addMember("reader", [visible.id]);
    // interleaved, so hidden events sit between the visible ones in seq order
    const [first] = await atFakeTimeAsync([
      () => file(visible.id, "v1", loud.key),
      () => file(hidden.id, "h1", secret.key),
      () => file(hidden.id, "h2"),
    ]);
    visibleIssue = first as string;
    await atFakeTimeAsync<unknown>([
      () => v1("PATCH", `/issues/${visibleIssue}`, { status: "done" }),
      () => v1("PATCH", `/issues/${visibleIssue}`, { title: "renamed only" }),
      () => file(hidden.id, "h3"),
      () => v1("POST", `/issues/${visibleIssue}/comments`, { body: "hello" }),
      () => file(hidden.id, "h4"),
    ]);
  });

  const feed = async (query = "") => {
    const res = await request("GET", `/api/web/feed${query}`, {
      key: null,
      cookie,
    });
    return { status: res.status, body: (await res.json()) as Body };
  };

  test("shows only visible projects' entries, newest first, and skips a change it has no entry for", async () => {
    const { status, body } = await feed();
    expect(status).toBe(200);
    expect(
      body.items.map((e: Body) => [e.kind, e.project.key, e.issue?.title]),
    ).toEqual([
      ["comment", visible.key, "renamed only"],
      ["status_changed", visible.key, "renamed only"],
      ["issue_created", visible.key, "renamed only"],
    ]);
    expect(body.nextCursor).toBeNull();
  });

  test("pages by limit with a cursor, and the last visible page has no cursor though hidden events are older", async () => {
    const kinds: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const { body } = await feed(`?limit=1${query}`);
      expect(body.items).toHaveLength(1);
      kinds.push(body.items[0].kind);
      cursor = body.nextCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(kinds).toEqual(["comment", "status_changed", "issue_created"]);
  });

  test("offers as filters the bots that acted in visible projects and the visible projects", async () => {
    const { body } = await feed();
    expect(body.filters).toEqual({
      actors: [
        {
          id: loud.actor.id,
          name: "loud",
          kind: "bot",
          photoUrl: null,
          title: null,
        },
        {
          id: expect.any(String),
          name: "tester",
          kind: "bot",
          photoUrl: null,
          title: null,
        },
      ],
      projects: [{ key: visible.key, name: "Visible" }],
    });
  });

  test("filters by actor and by project", async () => {
    const byActor = await feed(`?actor=${loud.actor.id}`);
    expect(byActor.body.items.map((e: Body) => e.kind)).toEqual([
      "issue_created",
    ]);
    const byProject = await feed(`?project=${visible.key.toLowerCase()}`);
    expect(byProject.body.items).toHaveLength(3);
  });

  test("a cursor goes back only with the filters it was issued under", async () => {
    const { body } = await feed(`?limit=1&project=${visible.key}`);
    const res = await feed(`?limit=1&cursor=${body.nextCursor}`);
    expect(res.status).toBe(422);
  });
});

test("the bot filter lists each bot with an event in any visible project once, by name in binary order, and no human, hidden-only or idle bot", async () => {
  const first = addProject("Bots first");
  const second = addProject("Bots second");
  const elsewhere = addProject("Bots elsewhere");
  const beta = addBot("beta");
  const alpha = addBot("Alpha");
  const zed = addBot("Zed");
  const hiddenOnly = addBot("hidden-only");
  addBot("idle");
  const cookie = await addMember("bot-watcher", [first.id, second.id]);
  const file = (projectId: string, key: string) =>
    v1("POST", "/issues", { projectId, title: "t" }, key);
  await file(first.id, beta.key);
  await file(second.id, beta.key);
  await file(second.id, alpha.key);
  await file(first.id, zed.key);
  await file(elsewhere.id, hiddenOnly.key);
  const byHuman = await request("POST", "/api/web/issues", {
    key: null,
    cookie,
    json: { projectKey: first.key, title: "by a person" },
  });
  expect(byHuman.status).toBe(201);

  const res = await request("GET", "/api/web/feed", { key: null, cookie });
  const body = (await res.json()) as Body;
  expect(body.filters.actors).toEqual([
    {
      id: alpha.actor.id,
      name: "Alpha",
      kind: "bot",
      photoUrl: null,
      title: null,
    },
    { id: zed.actor.id, name: "Zed", kind: "bot", photoUrl: null, title: null },
    {
      id: beta.actor.id,
      name: "beta",
      kind: "bot",
      photoUrl: null,
      title: null,
    },
  ]);
  // a person is no filter, and in the feed itself carries a title of null
  const personEvent = body.items.find((e: Body) => e.actor.kind === "human");
  expect(personEvent.actor).toEqual({
    id: expect.any(String),
    name: expect.any(String),
    kind: "human",
    photoUrl: null,
    title: null,
  });
});
