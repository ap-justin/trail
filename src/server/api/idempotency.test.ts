import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { activityEvent, issue as issueTable } from "../db/schema.js";
import { storeResult } from "../service/idempotency.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, app, bot, addBot, request, published } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

function post(
  path: string,
  json: unknown,
  idempotencyKey: string,
  key = bot.key,
) {
  return app.request(`/api/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(json),
  });
}

const eventCount = () => db.select().from(activityEvent).all().length;

let project: Body;
let issue: Body;
beforeAll(async () => {
  project = (await (
    await request("POST", "/api/v1/projects", {
      json: { key: "IDEM", name: "idempotency" },
    })
  ).json()) as Body;
  issue = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: project.id, title: "target" },
    })
  ).json()) as Body;
});

describe("a create repeated with its Idempotency-Key returns the first response and writes nothing", () => {
  // thunks: the rows are built before beforeAll has created the ids they name
  test.each([
    ["POST /projects", () => "/projects", () => ({ key: "IDP", name: "p" })],
    [
      "POST /issues",
      () => "/issues",
      () => ({ projectId: project.id, title: "once", labels: ["l"] }),
    ],
    [
      "POST /issues/:id/comments",
      () => `/issues/${issue.id}/comments`,
      () => ({ body: "once" }),
    ],
    [
      "POST /projects/:id/status-updates",
      () => `/projects/${project.id}/status-updates`,
      () => ({ body: "once", health: "on_track" }),
    ],
    [
      "POST /projects/:id/labels",
      () => `/projects/${project.id}/labels`,
      () => ({ name: "once" }),
    ],
    [
      "POST /products",
      () => "/products",
      () => ({ key: "IDN", name: "new route" }),
    ],
    [
      "POST /items (todo)",
      () => "/items",
      () => ({ type: "todo", product: project.key, title: "once" }),
    ],
    [
      "POST /items (issue)",
      () => "/items",
      () => ({ type: "issue", product: project.key, title: "once" }),
    ],
    [
      "POST /items/:key/comments",
      () => `/items/${issue.key}/comments`,
      () => ({ body: "once" }),
    ],
    [
      "POST /projects (a project)",
      () => "/projects",
      () => ({ name: "once", products: [project.key] }),
    ],
    [
      "POST /products/:key/status-updates",
      () => `/products/${project.key}/status-updates`,
      () => ({ body: "once", health: "on_track" }),
    ],
    [
      "POST /products/:key/labels",
      () => `/products/${project.key}/labels`,
      () => ({ name: "once on the new route" }),
    ],
  ])("%s", async (name, path, json) => {
    const key = `retry ${name}`;
    const first = await post(path(), json(), key);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const events = eventCount();
    const publishedBefore = published.length;

    const again = await post(path(), json(), key);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(firstBody);
    expect(eventCount()).toBe(events);
    expect(published.length).toBe(publishedBefore);
  });
});

test("the replay is the first response even after the row has changed", async () => {
  const json = { projectId: project.id, title: "original" };
  const first = (await (await post("/issues", json, "changes")).json()) as Body;
  await request("PATCH", `/api/v1/issues/${first.id}`, {
    json: { title: "edited" },
  });
  const again = (await (await post("/issues", json, "changes")).json()) as Body;
  expect(again).toEqual(first);
  expect(again.title).toBe("original");
});

test("a body with its fields in another order is the same request", async () => {
  const first = await post(
    "/issues",
    {
      title: "ordered",
      projectId: project.id,
      labels: ["a", "b"],
      links: [{ title: "PR", url: "https://github.com/o/r/pull/1" }],
    },
    "reordered",
  );
  expect(first.status).toBe(201);
  const events = eventCount();
  const again = await post(
    "/issues",
    {
      links: [{ url: "https://github.com/o/r/pull/1", title: "PR" }],
      labels: ["a", "b"],
      projectId: project.id,
      title: "ordered",
    },
    "reordered",
  );
  expect(again.status).toBe(201);
  expect(await again.json()).toEqual(await first.json());
  expect(eventCount()).toBe(events);
});

test("a reference sent as a key or an id is the same request", async () => {
  const byId = await post(
    "/issues",
    { projectId: project.id, title: "ref" },
    "by ref",
  );
  const byKey = await post(
    "/issues",
    { projectId: "idem", title: "ref" },
    "by ref",
  );
  expect(byKey.status).toBe(201);
  expect(await byKey.json()).toEqual(await byId.json());
});

test("the same key with a different body is a 422 telling the bot to use a new key", async () => {
  await post("/issues", { projectId: project.id, title: "a" }, "reused");
  const events = eventCount();
  const res = await post(
    "/issues",
    { projectId: project.id, title: "b" },
    "reused",
  );
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: {
      code: "idempotency_key_reused",
      message:
        'idempotency key "reused" was already used for a different request body or target: send a new key for a new create, or resend the first request unchanged to get its result',
    },
  });
  expect(eventCount()).toBe(events);
});

test("the same key on another kind of create is a 422 naming the first", async () => {
  await post("/issues", { projectId: project.id, title: "scoped" }, "scoped");
  const res = await post(
    `/issues/${issue.id}/comments`,
    { body: "x" },
    "scoped",
  );
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^idempotency key "scoped" was already used for a different operation \(issue\.create\)/,
  );
});

test("the same key on the same create for another issue is a 422", async () => {
  const other = (await (
    await request("POST", "/api/v1/issues", {
      json: { projectId: project.id, title: "other" },
    })
  ).json()) as Body;
  await post(`/issues/${issue.id}/comments`, { body: "same" }, "target");
  const res = await post(
    `/issues/${other.id}/comments`,
    { body: "same" },
    "target",
  );
  expect(res.status).toBe(422);
});

test("keys are per bot: another bot's same key is its own create", async () => {
  const other = addBot("idem other");
  const json = { projectId: project.id, title: "mine" };
  const a = (await (await post("/issues", json, "shared")).json()) as Body;
  const b = (await (
    await post("/issues", json, "shared", other.key)
  ).json()) as Body;
  expect(b.id).not.toBe(a.id);
  expect(b.createdBy).toBe(other.actor.id);
});

test("a create that failed stores nothing, so its key can be retried", async () => {
  const key = projectKey();
  await request("POST", "/api/v1/projects", { json: { key, name: "holder" } });
  const failed = await post("/projects", { key, name: "clash" }, "after fail");
  expect(failed.status).toBe(409);
  const fixed = await post(
    "/projects",
    { key: projectKey(), name: "clash" },
    "after fail",
  );
  expect(fixed.status).toBe(201);
});

test("an empty Idempotency-Key is a 422", async () => {
  const res = await post("/issues", { projectId: project.id, title: "e" }, "");
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.message).toMatch(
    /^idempotency-key: /,
  );
});

describe("a key stored before items had products and types", () => {
  // the request issue.create hashed and the item it stored before migration 0015
  function storeLegacyCreate(
    idempotencyKey: string,
    itemId: string,
    sent: { assigneeId?: string; labels?: string[]; links?: unknown[] } = {},
  ) {
    const row = db
      .select()
      .from(issueTable)
      .where(eq(issueTable.id, itemId))
      .get();
    if (!row) throw new Error(`no item ${itemId}`);
    const { productId, type, ...unchanged } = row;
    db.transaction((tx) =>
      storeResult(
        tx,
        bot.actor.id,
        {
          key: idempotencyKey,
          scope: "issue.create",
          request: {
            projectId: productId,
            title: row.title,
            description: row.description,
            assigneeId: sent.assigneeId ?? null,
            estimate: null,
            priority: 0,
            externalRef: null,
            labels: sent.labels ?? [],
            links: sent.links ?? [],
          },
        },
        {
          ...unchanged,
          projectId: productId,
          key: `IDEM-${row.number}`,
          labels: [],
          links: [],
        },
      ),
    );
  }

  test("replays the stored item when the same create is retried", async () => {
    const first = (await (
      await request("POST", "/api/v1/issues", {
        json: { projectId: project.id, title: "before the release" },
      })
    ).json()) as Body;
    storeLegacyCreate("legacy retry", first.id);
    const items = db.select().from(issueTable).all().length;

    const again = await post(
      "/issues",
      { projectId: project.id, title: "before the release" },
      "legacy retry",
    );
    expect(again.status).toBe(201);
    const body = (await again.json()) as Body;
    expect(body.id).toBe(first.id);
    expect(body.key).toBe(first.key);
    expect(body.product).toBe("IDEM");
    expect(db.select().from(issueTable).all().length).toBe(items);
  });

  test("replays a stored create that named an assignee, labels and links in today's shape", async () => {
    const sent = {
      projectId: project.id,
      title: "assigned before the release",
      assigneeId: "tester",
      labels: ["legacy-bug"],
      links: [{ url: "https://example.com/pull/1", title: "the fix" }],
    };
    const first = (await (
      await request("POST", "/api/v1/issues", { json: sent })
    ).json()) as Body;
    storeLegacyCreate("legacy assigned", first.id, {
      assigneeId: bot.actor.id,
      labels: ["legacy-bug"],
      links: [{ url: "https://example.com/pull/1", title: "the fix" }],
    });

    const again = await post("/issues", sent, "legacy assigned");
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({
      id: first.id,
      key: first.key,
      type: "todo",
      product: "IDEM",
      assigneeId: bot.actor.id,
      labels: ["legacy-bug"],
      links: [{ url: "https://example.com/pull/1", title: "the fix" }],
    });
  });

  test("a different create under that key is still a 422", async () => {
    const first = (await (
      await request("POST", "/api/v1/issues", {
        json: { projectId: project.id, title: "legacy original" },
      })
    ).json()) as Body;
    storeLegacyCreate("legacy reused", first.id);
    const res = await post(
      "/issues",
      { projectId: project.id, title: "something else" },
      "legacy reused",
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.code).toBe(
      "idempotency_key_reused",
    );
  });
});

describe("a retry hashes the request as the caller sent it, not values filled in from current data", () => {
  test("a legacy create retried after its product changed owner replays the todo it made", async () => {
    const product = (await (
      await request("POST", "/api/v1/products", {
        json: { key: projectKey(), name: "owner moves" },
      })
    ).json()) as Body;
    const json = { projectId: product.key, title: "planned" };
    const first = await post("/issues", json, "todo before owner move");
    expect(first.status).toBe(201);
    expect(((await first.clone().json()) as Body).type).toBe("todo");
    const heir = addBot("idem heir");
    await request("PATCH", `/api/v1/products/${product.key}`, {
      json: { owner: heir.actor.id },
    });
    const events = eventCount();
    const again = await post("/issues", json, "todo before owner move");
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    expect(eventCount()).toBe(events);
  });

  test("a project with no products named, retried after the caller came to own a second product, replays", async () => {
    const lead = addBot("idem lead");
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "lead's one" },
      key: lead.key,
    });
    const json = { name: "defaulted products" };
    const first = await post("/projects", json, "default products", lead.key);
    expect(first.status).toBe(201);
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "lead's second" },
      key: lead.key,
    });
    const again = await post("/projects", json, "default products", lead.key);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
  });
});

test("a product create stored before products were split from projects replays when retried", async () => {
  const made = (await (
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "before the split" },
    })
  ).json()) as Body;
  // the request project.create hashed, and the row it stored, before migration 0015
  db.transaction((tx) =>
    storeResult(
      tx,
      bot.actor.id,
      {
        key: "product before split",
        scope: "project.create",
        request: {
          name: "before the split",
          key: made.key,
          description: "",
          externalRef: null,
        },
      },
      {
        id: made.id,
        key: made.key,
        name: made.name,
        description: "",
        issueSeq: 0,
        externalRef: null,
        createdBy: bot.actor.id,
        createdAt: made.createdAt,
        updatedAt: made.updatedAt,
      },
    ),
  );
  const again = await post(
    "/projects",
    { key: made.key, name: "before the split" },
    "product before split",
  );
  expect(again.status).toBe(201);
  expect(await again.json()).toMatchObject({
    id: made.id,
    key: made.key,
    owner: made.owner,
    deprecated: expect.any(String),
  });
});

test("a product create stored before products had a kind replays with kind product", async () => {
  const made = (await (
    await request("POST", "/api/v1/products", {
      json: { key: projectKey(), name: "before kind" },
    })
  ).json()) as Body;
  // the request and the row create_product stored between migrations 0015 and 0022
  db.transaction((tx) =>
    storeResult(
      tx,
      bot.actor.id,
      {
        key: "product before kind",
        scope: "project.create",
        request: {
          name: "before kind",
          key: made.key,
          description: "",
          externalRef: null,
          repoUrl: null,
          ownerId: undefined,
        },
      },
      {
        id: made.id,
        key: made.key,
        name: made.name,
        description: "",
        issueSeq: 0,
        externalRef: null,
        ownerId: bot.actor.id,
        repoUrl: null,
        createdBy: bot.actor.id,
        createdAt: made.createdAt,
        updatedAt: made.updatedAt,
      },
    ),
  );
  const again = await post(
    "/products",
    { key: made.key, name: "before kind" },
    "product before kind",
  );
  expect(again.status).toBe(201);
  expect(await again.json()).toMatchObject({ id: made.id, kind: "product" });
});
