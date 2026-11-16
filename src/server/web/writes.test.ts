import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { activityEvent } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";

const { db, request, addMember, addProject } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const p = addProject("Writable");
const cookie = await addMember("writer", [p.id], { name: "Wendy Writer" });

const web = async (
  method: string,
  path: string,
  json?: unknown,
  origin?: string | null,
) => {
  const res = await request(method, `/api/web${path}`, {
    key: null,
    cookie,
    json,
    origin,
  });
  return { status: res.status, body: (await res.json()) as Body };
};

const human = { id: expect.any(String), name: "Wendy Writer", kind: "human" };

test("a member files an issue as itself: 201 with the issue in triage, and the feed shows it filed by a human", async () => {
  const { status, body } = await web("POST", "/issues", {
    product: p.key.toLowerCase(),
    title: "  Broken button ",
    description: "It does nothing.",
  });
  expect(status).toBe(201);
  expect(body).toMatchObject({
    key: `${p.key}-1`,
    title: "Broken button",
    description: "It does nothing.",
    type: "issue",
    status: "triage",
    product: { key: p.key, name: "Writable" },
    assignee: null,
    creator: human,
    timeline: [{ kind: "item_created", actor: human }],
  });
  const feed = await web("GET", "/feed");
  expect(feed.body.items[0]).toMatchObject({
    kind: "item_created",
    actor: human,
    product: { key: p.key, name: "Writable" },
    item: { key: `${p.key}-1`, title: "Broken button", type: "issue" },
  });
});

test("filing takes only product, title and description: any other field is a 422 and writes nothing", async () => {
  const before = db.select().from(activityEvent).all().length;
  for (const extra of [
    { status: "done" },
    { type: "todo" },
    { projectKey: p.key },
    { priority: 1 },
    { labels: ["x"] },
    { assigneeId: "someone" },
    { estimate: 2 },
    { links: [] },
    { externalRef: "x" },
  ]) {
    const { status } = await web("POST", "/issues", {
      product: p.key,
      title: "t",
      ...extra,
    });
    expect(status, JSON.stringify(extra)).toBe(422);
  }
  expect(db.select().from(activityEvent).all()).toHaveLength(before);
});

test("a member comments as itself: 201 with the timeline entry, and the comment reaches the feed and the timeline", async () => {
  const filed = await web("POST", "/issues", { product: p.key, title: "c" });
  const { status, body } = await web(
    "POST",
    `/items/${filed.body.key}/comments`,
    {
      body: "Me too.",
    },
  );
  expect(status).toBe(201);
  expect(body).toMatchObject({
    kind: "comment",
    actor: human,
    product: { key: p.key, name: "Writable" },
    project: null,
    item: { key: filed.body.key, title: "c", type: "issue" },
    comment: { body: "Me too.", sourceAuthor: null },
  });
  const event = db
    .select()
    .from(activityEvent)
    .where(eq(activityEvent.subjectId, body.comment.id))
    .get();
  expect(event).toMatchObject({
    action: "comment.created",
    actorId: body.actor.id,
  });
  expect((await web("GET", "/feed")).body.items[0]).toMatchObject({
    kind: "comment",
    actor: human,
  });
  expect(
    (await web("GET", `/items/${filed.body.key}`)).body.timeline.at(-1),
  ).toMatchObject({
    kind: "comment",
    comment: { body: "Me too." },
  });
});

test.each([
  ["no Origin", null],
  ["another site's Origin", "https://evil.example"],
])("a write with %s is a 403 and writes nothing", async (_, origin) => {
  const before = db.select().from(activityEvent).all().length;
  const res = await web(
    "POST",
    "/issues",
    { product: p.key, title: "x" },
    origin,
  );
  expect(res).toEqual({
    status: 403,
    body: { error: { code: "bad_origin", message: expect.any(String) } },
  });
  expect(db.select().from(activityEvent).all()).toHaveLength(before);
});

test("a member comments on a todo too", async () => {
  const todo = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: p.key, title: "planned" },
  });
  const { key } = (await todo.json()) as { key: string };
  const { status, body } = await web("POST", `/items/${key}/comments`, {
    body: "Looks good.",
  });
  expect(status).toBe(201);
  expect(body.item).toEqual({ key, title: "planned", type: "todo" });
});

// a person files issues and comments; todos, projects and every other write stay the bots'
test.each([
  ["POST", "/items"],
  ["POST", "/todos"],
  ["PATCH", "/items/X-1"],
  ["DELETE", "/items/X-1"],
  ["PATCH", "/issues/X-1"],
  ["POST", "/projects"],
  ["PATCH", "/projects/launch"],
  ["POST", "/projects/launch/items"],
  ["POST", "/products"],
  ["POST", "/status-updates"],
  ["POST", "/issues/X-1/comments"],
  ["PUT", "/items/X-1/comments"],
])("%s %s is not a route", async (method, path) => {
  expect((await web(method, path, {})).status).toBe(404);
});

test.each([
  ["a title", () => "/issues", { product: p.key, title: " \t\n " }, "title"],
  [
    "a comment",
    async () => {
      const filed = await web("POST", "/issues", {
        product: p.key,
        title: "w",
      });
      return `/items/${filed.body.key}/comments`;
    },
    { body: " \n\t " },
    "body",
  ],
])(
  "%s of only whitespace is the validator's 422 and writes nothing",
  async (_, pathOf, json, field) => {
    const path = await pathOf();
    const before = db.select().from(activityEvent).all().length;
    const { status, body } = await web("POST", path, json);
    expect(status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    // the validator's message names the field's path; the service's check beyond it does not
    expect(body.error.message).toMatch(new RegExp(`^${field}: `));
    expect(db.select().from(activityEvent).all()).toHaveLength(before);
  },
);

test.each([
  ["empty", ""],
  ["301 characters", "t".repeat(301)],
])("a %s title is the validator's 422 and writes nothing", async (_, title) => {
  const before = db.select().from(activityEvent).all().length;
  const { status, body } = await web("POST", "/issues", {
    product: p.key,
    title,
  });
  expect(status).toBe(422);
  expect(body.error.code).toBe("validation_failed");
  expect(body.error.message).toMatch(/^title: /);
  expect(db.select().from(activityEvent).all()).toHaveLength(before);
});

test("a 300-character title is filed whole", async () => {
  const title = "t".repeat(300);
  const { status, body } = await web("POST", "/issues", {
    product: p.key,
    title,
  });
  expect(status).toBe(201);
  expect(body.title).toBe(title);
});

test("an empty comment body is the validator's 422 and writes nothing", async () => {
  const filed = await web("POST", "/issues", { product: p.key, title: "e" });
  const before = db.select().from(activityEvent).all().length;
  const { status, body } = await web(
    "POST",
    `/items/${filed.body.key}/comments`,
    { body: "" },
  );
  expect(status).toBe(422);
  expect(body.error.code).toBe("validation_failed");
  expect(body.error.message).toMatch(/^body: /);
  expect(db.select().from(activityEvent).all()).toHaveLength(before);
});

test("a bot's bearer key is not a person's session: /api/web answers 401 and files nothing", async () => {
  const before = db.select().from(activityEvent).all().length;
  const res = await request("POST", "/api/web/issues", {
    json: { product: p.key, title: "from a bot" },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({
    error: { code: "unauthorized", message: expect.any(String) },
  });
  expect(db.select().from(activityEvent).all()).toHaveLength(before);
});
