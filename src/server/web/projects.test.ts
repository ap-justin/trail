import { beforeAll, describe, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { db, request, signIn, owner, addMember, addProject, addBot } =
  setupTestApp();
const { get, item, project, statusUpdate } = webSeed(request);

/** The raw JSON text of a web GET, to prove what it never contains. */
async function text(path: string, cookie: string) {
  const res = await request("GET", `/api/web${path}`, { key: null, cookie });
  return res.text();
}

// One project across a product the member sees (Alpha, Beta) and one they don't (Gamma).
let alpha: { id: string; key: string };
let beta: { id: string; key: string };
let gamma: { id: string; key: string };
let member = "";
let ownerCookie = "";
let keys: Record<string, string> = {};
beforeAll(async () => {
  alpha = addProject("Alpha");
  beta = addProject("Beta");
  gamma = addProject("Gamma");
  // keys sort A to Z in creation order, so alpha < beta < gamma
  const made = await atFakeTimeAsync([
    () => item(alpha.key, "issue"),
    () => item(alpha.key, "todo", { status: "done" }),
    () => item(beta.key, "issue", { status: "open" }),
    () => item(beta.key, "todo"),
    () => item(gamma.key, "issue"),
    () => item(gamma.key, "todo"),
  ]);
  const [a1, a2, b1, b2, g1, g2] = made as string[];
  keys = {
    a1: a1 as string,
    a2: a2 as string,
    b1: b1 as string,
    b2: b2 as string,
    g1: g1 as string,
    g2: g2 as string,
  };
  addBot("lead-bot");
  await atFakeTimeAsync([
    () =>
      project(
        "Launch",
        [alpha.key, beta.key, gamma.key],
        [a1, a2, b1, b2, g1, g2] as string[],
        { goal: "Ship it", lead: "lead-bot", targetDate: "2026-12-24" },
      ),
    () => project("Seen only", [alpha.key]),
    () => project("Gamma only", [gamma.key], [g1 as string]),
  ]);
  await statusUpdate({ project: "launch" }, "going well", "on_track");
  member = await addMember("partial", [alpha.id, beta.id]);
  ownerCookie = await signIn(owner);
});

describe("GET /projects", () => {
  test("a member sees only projects drawing from their products, each listing only those products", async () => {
    const { status, body } = await get("/projects", member);
    expect(status).toBe(200);
    expect(body.items.map((p: Body) => p.slug)).toEqual([
      "seen-only",
      "launch",
    ]);
    expect(body.items[1]).toEqual({
      slug: "launch",
      name: "Launch",
      goal: "Ship it",
      health: "on_track",
      latestStatusUpdate: expect.objectContaining({ body: "going well" }),
      lead: expect.objectContaining({ name: "lead-bot", kind: "bot" }),
      targetDate: "2026-12-24",
      products: [
        { key: alpha.key, name: "Alpha" },
        { key: beta.key, name: "Beta" },
      ],
      // alpha's triage issue and beta's open issue and open todo; gamma's never
      openCount: 3,
      updatedAt: expect.any(String),
    });
    expect(body.nextCursor).toBeNull();
  });

  test("the owner sees every project and every product", async () => {
    const { body } = await get("/projects", ownerCookie);
    const launch = body.items.find((p: Body) => p.slug === "launch");
    expect(body.items.map((p: Body) => p.slug)).toEqual(
      expect.arrayContaining(["launch", "seen-only", "gamma-only"]),
    );
    expect(launch.products.map((p: Body) => p.key)).toEqual([
      alpha.key,
      beta.key,
      gamma.key,
    ]);
    expect(launch.openCount).toBe(5);
  });

  test("pages newest first", async () => {
    const first = await get("/projects?limit=1", member);
    expect(first.body.items.map((p: Body) => p.slug)).toEqual(["seen-only"]);
    const rest = await get(
      `/projects?limit=1&cursor=${first.body.nextCursor}`,
      member,
    );
    expect(rest.body.items.map((p: Body) => p.slug)).toEqual(["launch"]);
  });

  test("names no hidden product", async () => {
    const json = await text("/projects", member);
    expect(json).toContain(alpha.key);
    expect(json).not.toContain(gamma.key);
    expect(json).not.toContain("Gamma");
  });
});

describe("GET /projects/:slug", () => {
  test("says a product is hidden, and lists the visible ones", async () => {
    const { status, body } = await get("/projects/launch", member);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      slug: "launch",
      hiddenProducts: true,
      products: [{ key: alpha.key }, { key: beta.key }],
      openCount: 3,
    });
  });

  test("hiddenProducts is false when the viewer sees every product", async () => {
    const asOwner = await get("/projects/launch", ownerCookie);
    const seen = await get("/projects/seen-only", member);
    expect(asOwner.body.hiddenProducts).toBe(false);
    expect(seen.body.hiddenProducts).toBe(false);
  });

  test("a project with none of the member's products is the same 404 as an unknown one", async () => {
    const hidden = await get("/projects/gamma-only", member);
    const unknown = await get("/projects/nope", member);
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.body.error.message).toBe("no project gamma-only");
    expect(unknown.body.error.message).toBe("no project nope");
  });

  test("names no hidden product", async () => {
    const json = await text("/projects/launch", member);
    expect(json).not.toContain(gamma.key);
    expect(json).not.toContain("Gamma");
  });
});

describe("GET /projects/:slug/items", () => {
  test("groups the visible items by product A to Z, newest first in each, with counts over visible items", async () => {
    const { status, body } = await get("/projects/launch/items", member);
    expect(status).toBe(200);
    expect(
      body.groups.map((g: Body) => [
        g.product.key,
        g.count,
        g.items.map((i: Body) => [i.key, i.type, i.status]),
      ]),
    ).toEqual([
      [
        alpha.key,
        2,
        [
          [keys.a2, "todo", "done"],
          [keys.a1, "issue", "triage"],
        ],
      ],
      [
        beta.key,
        2,
        [
          [keys.b2, "todo", "open"],
          [keys.b1, "issue", "open"],
        ],
      ],
    ]);
    expect(body.counts).toEqual({
      all: { all: 4, open: 3, in_progress: 0, done: 1, canceled: 0 },
      issue: { all: 2, open: 2, in_progress: 0, done: 0, canceled: 0 },
      todo: { all: 2, open: 1, in_progress: 0, done: 1, canceled: 0 },
    });
    expect(body.nextCursor).toBeNull();
  });

  test("the product filter shows one group, and the counts follow it", async () => {
    const { body } = await get(
      `/projects/launch/items?product=${beta.key.toLowerCase()}`,
      member,
    );
    expect(body.groups.map((g: Body) => g.product.key)).toEqual([beta.key]);
    expect(body.counts.all).toEqual({
      all: 2,
      open: 2,
      in_progress: 0,
      done: 0,
      canceled: 0,
    });
  });

  test("type and status filters drop the groups left empty, and group counts follow them", async () => {
    const { body } = await get(
      "/projects/launch/items?type=todo&status=open",
      member,
    );
    expect(
      body.groups.map((g: Body) => [
        g.product.key,
        g.count,
        g.items.map((i: Body) => i.key),
      ]),
    ).toEqual([[beta.key, 1, [keys.b2]]]);
    expect(body.counts.all.all).toBe(4);
  });

  test("filtering by a product the member can't see is the same 404 as one the project lacks", async () => {
    const hidden = await get(
      `/projects/launch/items?product=${gamma.key}`,
      member,
    );
    const absent = await get("/projects/launch/items?product=NOPE", member);
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(hidden.body.error.message).toBe(
      absent.body.error.message.replace("NOPE", gamma.key),
    );
  });

  test("pages across groups, each group's count the same on every page", async () => {
    const first = await get("/projects/launch/items?limit=3", member);
    expect(
      first.body.groups.map((g: Body) => [
        g.product.key,
        g.count,
        g.items.length,
      ]),
    ).toEqual([
      [alpha.key, 2, 2],
      [beta.key, 2, 1],
    ]);
    const rest = await get(
      `/projects/launch/items?limit=3&cursor=${first.body.nextCursor}`,
      member,
    );
    expect(rest.body).toMatchObject({
      groups: [
        { product: { key: beta.key }, count: 2, items: [{ key: keys.b1 }] },
      ],
      nextCursor: null,
    });
  });

  test("a cursor sent with other filters than it was issued under is a 422 saying to start again without it", async () => {
    const first = await get("/projects/launch/items?limit=1", member);
    const cursor = first.body.nextCursor;
    for (const filter of ["status=done", "type=todo", `product=${beta.key}`]) {
      const res = await get(
        `/projects/launch/items?limit=1&${filter}&cursor=${cursor}`,
        member,
      );
      expect(res.status, filter).toBe(422);
      expect(res.body.error.message).toBe(
        "cursor was issued for other filters: it pages only the list it came from, so leave cursor out to start this list from its first page",
      );
    }
    const kept = await get(
      `/projects/launch/items?limit=1&cursor=${cursor}`,
      member,
    );
    expect(kept.status).toBe(200);
  });

  test("a cursor issued under a filter pages on under that filter, the product in any case", async () => {
    for (const product of [beta.key, beta.key.toLowerCase()]) {
      const first = await get(
        `/projects/launch/items?limit=1&product=${product}`,
        member,
      );
      expect(first.body.groups[0].items.map((i: Body) => i.key)).toEqual([
        keys.b2,
      ]);
      const next = await get(
        `/projects/launch/items?limit=1&product=${product}&cursor=${first.body.nextCursor}`,
        member,
      );
      expect(next.status, product).toBe(200);
      expect(next.body).toMatchObject({
        groups: [{ product: { key: beta.key }, items: [{ key: keys.b1 }] }],
        nextCursor: null,
      });
    }
    const typed = await get(
      "/projects/launch/items?limit=1&type=issue",
      member,
    );
    const nextTyped = await get(
      `/projects/launch/items?limit=1&type=issue&cursor=${typed.body.nextCursor}`,
      member,
    );
    expect(nextTyped.status).toBe(200);
    expect(
      [...typed.body.groups, ...nextTyped.body.groups].flatMap((g: Body) =>
        g.items.map((i: Body) => i.key),
      ),
    ).toEqual([keys.a1, keys.b1]);
  });

  test("a project with no items has no groups and zero counts", async () => {
    const { body } = await get("/projects/seen-only/items", member);
    expect(body.groups).toEqual([]);
    expect(body.counts.all.all).toBe(0);
  });

  test("names no hidden product, item or count", async () => {
    const json = await text("/projects/launch/items", member);
    expect(json).not.toContain(gamma.key);
    expect(json).not.toContain("Gamma");
  });

  test("an unreachable project is a 404 here too", async () => {
    const { status } = await get("/projects/gamma-only/items", member);
    expect(status).toBe(404);
  });
});

test("GET /projects/:slug/status-updates pages newest first, and 404s an unreachable project", async () => {
  await atFakeTimeAsync(
    ["one", "two"].map(
      (body) => () => statusUpdate({ project: "seen-only" }, body),
    ),
  );
  const first = await get("/projects/seen-only/status-updates?limit=1", member);
  expect(first.body.items.map((u: Body) => u.body)).toEqual(["two"]);
  const rest = await get(
    `/projects/seen-only/status-updates?limit=1&cursor=${first.body.nextCursor}`,
    member,
  );
  expect(rest.body).toMatchObject({
    items: [{ body: "one" }],
    nextCursor: null,
  });
  const hidden = await get("/projects/gamma-only/status-updates", member);
  expect(hidden.status).toBe(404);
});

describe("a person beside project-scoped keys", () => {
  test("a member invited by product sees the projects, products and counts they saw before", async () => {
    const before = await get("/projects", member);
    const launchBefore = await get("/projects/launch/items", member);
    createBot(db, "alpha project key", { scope: { projects: ["gamma-only"] } });
    createBot(db, "beta project key", {
      scope: { products: [alpha.key], projects: ["launch"] },
    });
    expect(await get("/projects", member)).toEqual(before);
    expect(await get("/projects/launch/items", member)).toEqual(launchBefore);
    expect(before.body.items[1].openCount).toBe(3);
    expect((await get("/projects/gamma-only", member)).status).toBe(404);
  });
});
