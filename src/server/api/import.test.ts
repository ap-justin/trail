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
    renumbered: [],
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

test("POST /import keeps an issue's number from an externalRef in the project's key form; one already held is renumbered", async () => {
  const keyed = {
    externalRef: "P-KEPT",
    key: "KPT",
    name: "Kept",
    issues: [{ ...payload.issues[0], externalRef: "KPT-187", comments: [] }],
  };
  expect(
    (await request("POST", "/api/v1/import", { json: keyed })).status,
  ).toBe(200);
  const kept = (await (
    await request("GET", "/api/v1/issues/KPT-187")
  ).json()) as Body;
  expect(kept.externalRef).toBe("KPT-187");

  const byHand = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: "KPT", title: "by hand" },
    })
  ).json()) as Body;
  expect(byHand.key).toBe("KPT-188");
  const res = await request("POST", "/api/v1/import", {
    json: {
      ...keyed,
      issues: [{ ...keyed.issues[0], externalRef: "KPT-188" }],
    },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Body;
  expect(body.renumbered).toEqual([
    { externalRef: "KPT-188", sourceKey: null, key: "KPT-189" },
  ]);
});

test("POST /import with a status name that maps to nothing and no statusType is a 422 asking for statusType", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: {
      ...payload,
      externalRef: "P-other",
      key: "IMQ",
      issues: [{ ...payload.issues[0], status: "In Review" }],
    },
  });
  expect(res.status).toBe(422);
  const body = (await res.json()) as Body;
  expect(body.error.code).toBe("validation_failed");
  expect(body.error.message).toContain(
    "send statusType too (Linear's state.type: backlog, unstarted, triage, started, completed, canceled, duplicate)",
  );
});

test("POST /import maps a custom state by statusType and shows its name as sourceStatus; neither field is a 422", async () => {
  const { status: _, ...stateless } = payload.issues[0] as Body;
  const custom = {
    ...payload,
    externalRef: "P-review",
    key: "IMR",
    issues: [{ ...stateless, status: "In Review", statusType: "started" }],
  };
  expect(
    (await request("POST", "/api/v1/import", { json: custom })).status,
  ).toBe(200);
  const issue = (await (
    await request("GET", "/api/v1/issues/IMR-1")
  ).json()) as Body;
  expect(issue).toMatchObject({
    status: "in_progress",
    sourceStatus: "In Review",
  });

  const res = await request("POST", "/api/v1/import", {
    json: { ...custom, issues: [stateless] },
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^issue lin-1 has neither status nor statusType: send statusType/,
  );
});

test("PATCH /issues/:id on an imported issue leaves sourceStatus, status change included", async () => {
  const custom = {
    ...payload,
    externalRef: "P-patched",
    key: "IMT",
    issues: [
      { ...payload.issues[0], status: "In Review", statusType: "started" },
    ],
  };
  expect(
    (await request("POST", "/api/v1/import", { json: custom })).status,
  ).toBe(200);
  const res = await request("PATCH", "/api/v1/issues/IMT-1", {
    json: { status: "done", title: "closed here" },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    status: "done",
    title: "closed here",
    sourceStatus: "In Review",
  });
  expect(
    ((await (await request("GET", "/api/v1/issues/IMT-1")).json()) as Body)
      .sourceStatus,
  ).toBe("In Review");
});

test("POST /import matches statusType in any case and refuses one outside the seven, naming the field", async () => {
  const { status: _, ...stateless } = payload.issues[0] as Body;
  const typed = (statusType: string, key: string) => ({
    ...payload,
    externalRef: `P-${key}`,
    key,
    issues: [{ ...stateless, statusType }],
  });
  expect(
    (
      await request("POST", "/api/v1/import", {
        json: typed(" Started", "IMS"),
      })
    ).status,
  ).toBe(200);
  expect(
    ((await (await request("GET", "/api/v1/issues/IMS-1")).json()) as Body)
      .status,
  ).toBe("in_progress");

  const res = await request("POST", "/api/v1/import", {
    json: typed("done", "IMT"),
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(/statusType/);
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
    "issues lists externalRef lin-1 twice: send each row once, merged into one. Nothing was imported: fix it and send the whole import again",
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

test("POST /import keeps a 200-character status as sourceStatus and refuses 201 with a 422", async () => {
  const withStatus = (status: string, key: string) => ({
    ...payload,
    externalRef: `P-${key}`,
    key,
    issues: [{ ...payload.issues[0], status, statusType: "started" }],
  });
  const long = "s".repeat(200);
  expect(
    (await request("POST", "/api/v1/import", { json: withStatus(long, "IML") }))
      .status,
  ).toBe(200);
  const issue = (await (
    await request("GET", "/api/v1/issues/IML-1")
  ).json()) as Body;
  expect(issue.sourceStatus).toBe(long);

  const res = await request("POST", "/api/v1/import", {
    json: withStatus(`${long}s`, "IMM"),
  });
  expect(res.status).toBe(422);
  expect((await request("GET", "/api/v1/issues/IMM-1")).status).toBe(404);
});

test("POST /import refuses a whitespace-only status with a 422 even beside a statusType", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: {
      ...payload,
      externalRef: "P-blank",
      key: "IMW",
      issues: [{ ...payload.issues[0], status: "   ", statusType: "started" }],
    },
  });
  expect(res.status).toBe(422);
  expect((await request("GET", "/api/v1/projects/IMW")).status).toBe(404);
});

test("POST /import keeps the number of a sourceKey in the project's key while matching by a UUID externalRef", async () => {
  const uuid = "2b5f6e1c-7d0a-4c3e-9f1b-8a6d4e2c1f07";
  const res = await request("POST", "/api/v1/import", {
    json: {
      externalRef: "P-SRC",
      key: "SRC",
      name: "by uuid",
      issues: [
        {
          externalRef: uuid,
          sourceKey: "SRC-187",
          title: "kept",
          status: "Todo",
          createdAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    },
  });
  expect(res.status).toBe(200);
  const kept = (await (
    await request("GET", "/api/v1/issues/SRC-187")
  ).json()) as Body;
  expect(kept.externalRef).toBe(uuid);
});

test("the spec shows an import issue's sourceKey, and says a re-run replaces trail's edits to matched rows", async () => {
  const res = await request("GET", "/api/v1/openapi.json", { key: null });
  const spec = (await res.json()) as Body;
  expect(spec.components.schemas.ImportIssue.properties.sourceKey).toEqual(
    expect.objectContaining({
      type: "string",
      pattern: "^[A-Za-z0-9]{2,10}-[1-9]\\d*$",
      description: expect.stringMatching(/keeps that number/),
    }),
  );
  expect(spec.components.schemas.ImportIssue.required).not.toContain(
    "sourceKey",
  );
  expect(spec.paths["/import"].post.description).toMatch(
    /replacing changes made in trail since the last import.*never deletes/s,
  );
});
