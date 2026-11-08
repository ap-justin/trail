import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { IMPORT_MAX_BODY_BYTES, MAX_BODY_BYTES } from "./routes.js";

const { bot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const payload = {
  externalRef: "P-JUS-9",
  key: "IMP",
  name: "Imported",
  issues: [
    {
      externalRef: "lin-1",
      title: "carry over",
      status: "In Progress",
      createdAt: "2026-01-02T03:04:05.000Z",
      sourceAuthor: "Ada",
      labels: ["Bug"],
      comments: [
        {
          externalRef: "lin-c1",
          body: "noted",
          createdAt: "2026-01-03T00:00:00+02:00",
        },
      ],
    },
  ],
};

const counts = (n: Partial<Record<string, number>>) => ({
  projects: 0,
  issues: 0,
  comments: 0,
  labels: 0,
  links: 0,
  statusUpdates: 0,
  ...n,
});

test("POST /import upserts the project and answers the per-kind counts", async () => {
  const res = await request("POST", "/api/v1/import", { json: payload });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Body;
  expect(body).toEqual({
    project: expect.objectContaining({
      key: "IMP",
      externalRef: "P-JUS-9",
      createdBy: bot.actor.id,
    }),
    created: counts({ projects: 1, issues: 1, comments: 1, labels: 1 }),
    updated: counts({}),
    unchanged: counts({}),
  });
  const issue = (await (
    await request("GET", "/api/v1/issues/IMP-1")
  ).json()) as Body;
  expect(issue).toMatchObject({
    status: "in_progress",
    createdAt: "2026-01-02T03:04:05.000Z",
    sourceAuthor: "Ada",
    completedAt: null,
  });
  const comments = (await (
    await request("GET", "/api/v1/issues/IMP-1/comments")
  ).json()) as Body;
  expect(comments.items).toMatchObject([
    { body: "noted", createdAt: "2026-01-02T22:00:00.000Z" },
  ]);

  const again = (await (
    await request("POST", "/api/v1/import", { json: payload })
  ).json()) as Body;
  expect(again.created).toEqual(counts({}));
  expect(again.unchanged).toEqual(body.created);
});

test("POST /import with an unknown status is a 422 listing the accepted names", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: {
      ...payload,
      externalRef: "P-other",
      key: "IMQ",
      issues: [{ ...payload.issues[0], status: "Triage" }],
    },
  });
  expect(res.status).toBe(422);
  const body = (await res.json()) as Body;
  expect(body.error.code).toBe("validation_failed");
  expect(body.error.message).toContain(
    "send one of Backlog, Todo, In Progress, Done, Canceled, Duplicate",
  );
});

test("POST /import with a duplicate issue externalRef is a 422 naming it", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: {
      ...payload,
      issues: [payload.issues[0], payload.issues[0]],
    },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toBe(
    "issues lists externalRef lin-1 twice: send each row once, merged into one",
  );
});

test("POST /import with a misspelled field is a 422 naming it", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: { ...payload, isues: [] },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(/isues/);
});

test("POST /import takes a body over the general limit, up to its own", async () => {
  const description = "x".repeat(60_000);
  const issues = Array.from({ length: 20 }, (_, i) => ({
    externalRef: `big-${i}`,
    title: `big ${i}`,
    status: "Todo",
    createdAt: "2026-01-02T00:00:00.000Z",
    description,
  }));
  const big = { externalRef: "P-big", key: "BIG", name: "big", issues };
  expect(JSON.stringify(big).length).toBeGreaterThan(MAX_BODY_BYTES);
  const res = await request("POST", "/api/v1/import", { json: big });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Body).created.issues).toBe(20);
});

test("POST /import over its own limit is a 413", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: { ...payload, name: "x".repeat(IMPORT_MAX_BODY_BYTES) },
  });
  expect(res.status).toBe(413);
  expect(((await res.json()) as Body).error.code).toBe("payload_too_large");
});

test("POST /import without a key is a 401", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: payload,
    key: null,
  });
  expect(res.status).toBe(401);
});
