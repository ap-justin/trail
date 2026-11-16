import { and, asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { FeedView, MeView } from "../../shared/schemas.js";
import { activityEvent } from "../db/schema.js";
import { atFakeTimeAsync, readEventStream, setupTestApp } from "../test-app.js";

const {
  app,
  db,
  request,
  addProject,
  addBot,
  addMember,
  inviteEmail,
  signInWithEmail,
} = setupTestApp();

const get = async <T>(path: string, cookie: string) => {
  const res = await request("GET", `/api/web${path}`, { key: null, cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

/** Three projects with two issues each filed by a bot, and a fourth nobody invited sees. */
async function seed(tag: string) {
  const bot = addBot(`filer-${tag}`);
  const mine = ["Alpha", "Beta", "Gamma"].map((n) => addProject(n));
  const other = addProject("Other");
  const file = (projectId: string, title: string) =>
    request("POST", "/api/v1/issues", {
      json: { projectId, title },
      key: bot.key,
    });
  await atFakeTimeAsync(
    [...mine, other].flatMap((p) => [
      () => file(p.id, `first in ${p.name}`),
      () => file(p.id, `second in ${p.name}`),
    ]),
  );
  return { mine, other };
}

describe("a member's feed with no filter", () => {
  for (const kind of ["email", "github"] as const) {
    test(`${kind}-invited: newest events across their projects, listed in the filters and in /me`, async () => {
      const { mine, other } = await seed(kind);
      const ids = mine.map((p) => p.id);
      if (kind === "email") inviteEmail("ada@example.com", ids);
      const cookie =
        kind === "email"
          ? await signInWithEmail("ada@example.com")
          : await addMember("grace", ids);

      const feed = await get<FeedView>("/feed", cookie);
      expect(feed.items.map((e) => e.product?.key)).toHaveLength(6);
      expect(new Set(feed.items.map((e) => e.product?.key))).toEqual(
        new Set(mine.map((p) => p.key)),
      );
      expect(feed.items.map((e) => e.product?.key)).not.toContain(other.key);
      expect(feed.filters.products.map((p) => p.key).sort()).toEqual(
        mine.map((p) => p.key).sort(),
      );
      expect(feed.filters.actors.map((a) => a.name)).toEqual([`filer-${kind}`]);

      const me = await get<MeView>("/me", cookie);
      expect(me.products?.map((p) => p.key).sort()).toEqual(
        mine.map((p) => p.key).sort(),
      );
    });
  }
});

describe("a member's feed of an import", () => {
  // the temp DB lives for the whole file, so each test imports its own project
  const importPayload = (
    tag: string,
    title: string,
    comments: { externalRef: string; body: string }[],
  ) => ({
    externalRef: `LIN-${tag}`,
    key: `IMP${tag.toUpperCase()}`,
    name: `Imported ${tag}`,
    issues: [
      {
        externalRef: "lin-1",
        title,
        status: "Todo",
        createdAt: "2026-01-02T03:04:05.000Z",
        comments: comments.map((c) => ({
          ...c,
          createdAt: "2026-01-03T00:00:00.000Z",
        })),
      },
      {
        externalRef: "lin-2",
        title: "second",
        status: "Todo",
        createdAt: "2026-01-02T03:04:06.000Z",
        comments: [],
      },
    ],
  });
  const noted = { externalRef: "lin-c1", body: "noted" };
  const later = { externalRef: "lin-c2", body: "added on re-import" };

  async function importProject(json: ReturnType<typeof importPayload>) {
    const res = await request("POST", "/api/v1/import", { json });
    expect(res.status).toBe(200);
    return ((await res.json()) as { project: { id: string } }).project.id;
  }

  async function memberFeed(tag: string, projectId: string) {
    const email = `imp-${tag}@example.com`;
    inviteEmail(email, [projectId]);
    return get<FeedView>("/feed", await signInWithEmail(email));
  }

  test("a member of an imported project sees one row with each count in its own field", async () => {
    const id = await importProject(importPayload("a", "carried over", [noted]));
    const feed = await memberFeed("a", id);
    expect(feed.items).toMatchObject([
      {
        kind: "product_imported",
        product: { key: "IMPA" },
        imported: { issues: 2, comments: 1 },
      },
    ]);
  });

  test("a re-import that retitles an issue and adds a comment shows the summed counts", async () => {
    const id = await importProject(importPayload("b", "carried over", [noted]));
    await importProject(
      importPayload("b", "carried over, renamed", [noted, later]),
    );
    const feed = await memberFeed("b", id);
    const rows = feed.items.filter((e) => e.kind === "product_imported");
    // first import: 2 issues + 1 comment; re-import: 1 issue updated + 1 comment created
    expect(rows.map((r) => r.imported)).toEqual(
      expect.arrayContaining([
        { issues: 2, comments: 1 },
        { issues: 1, comments: 1 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  test("a re-import that edits an existing comment moves the comments total", async () => {
    const id = await importProject(importPayload("e", "carried over", [noted]));
    await importProject(
      importPayload("e", "carried over", [{ ...noted, body: "noted, edited" }]),
    );
    const feed = await memberFeed("e", id);
    const rows = feed.items.filter((e) => e.kind === "product_imported");
    // nothing else changed, so the second row's comment count is `updated` alone
    expect(rows.map((r) => r.imported)).toEqual(
      expect.arrayContaining([
        { issues: 2, comments: 1 },
        { issues: 0, comments: 1 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  test("an import row shows for a member of the project and not for a member of another", async () => {
    const id = await importProject(importPayload("f", "carried over", [noted]));
    const elsewhere = addProject("Elsewhere");
    const insider = await memberFeed("f", id);
    const outsiderEmail = "imp-outsider@example.com";
    inviteEmail(outsiderEmail, [elsewhere.id]);
    const outsider = await get<FeedView>(
      "/feed",
      await signInWithEmail(outsiderEmail),
    );
    const importRows = (f: FeedView) =>
      f.items.filter((e) => e.kind === "product_imported");
    expect(importRows(insider)).toHaveLength(1);
    expect(importRows(outsider)).toEqual([]);
  });

  test("one malformed import event shows no row and the project's valid import still shows", async () => {
    const id = await importProject(importPayload("d", "carried over", [noted]));
    await importProject(importPayload("d", "carried over, renamed", [noted]));
    const [oldest, newest] = db
      .select({ id: activityEvent.id })
      .from(activityEvent)
      .where(
        and(
          eq(activityEvent.productId, id),
          eq(activityEvent.action, "product.imported"),
        ),
      )
      .orderBy(asc(activityEvent.seq))
      .all();
    expect(newest).toBeDefined();
    db.update(activityEvent)
      .set({ payload: { created: { issues: 2 } } })
      .where(eq(activityEvent.id, oldest?.id ?? ""))
      .run();
    const feed = await memberFeed("d", id);
    // the re-import's retitle: 1 issue updated, nothing else
    expect(feed.items).toMatchObject([
      { kind: "product_imported", imported: { issues: 1, comments: 0 } },
    ]);
  });

  describe("on the live stream", () => {
    async function openStream(cookie: string) {
      const res = await app.request("/api/web/events", { headers: { cookie } });
      expect(res.status).toBe(200);
      const stream = readEventStream(res);
      expect(await stream.next()).toEqual({ comment: "connected" });
      return stream;
    }

    // the project must exist before its member's stream opens, so the first import creates it
    // and the one sent while the stream is open is a retitle: 1 issue updated
    const retitle = (tag: string) =>
      importProject(importPayload(tag, "carried over, renamed", [noted]));

    test("a member of an imported project is sent the import as a product_imported entry", async () => {
      const id = await importProject(
        importPayload("g", "carried over", [noted]),
      );
      const email = "imp-g@example.com";
      inviteEmail(email, [id]);
      const stream = await openStream(await signInWithEmail(email));

      await retitle("g");

      expect(await stream.nextEntry()).toMatchObject({
        kind: "product_imported",
        product: { key: "IMPG" },
        imported: { issues: 1, comments: 0 },
      });
      await stream.cancel();
    });

    test("a member of another project is not sent it, though their own project's next entry arrives", async () => {
      await importProject(importPayload("h", "carried over", [noted]));
      const elsewhere = addProject("Elsewhere live");
      const email = "imp-h@example.com";
      inviteEmail(email, [elsewhere.id]);
      const stream = await openStream(await signInWithEmail(email));

      await retitle("h");
      // events are delivered in order, so a leaked import would arrive first
      const filed = await request("POST", "/api/v1/issues", {
        json: { projectId: elsewhere.id, title: "after the import" },
      });
      expect(filed.status).toBe(201);

      expect(await stream.nextEntry()).toMatchObject({
        kind: "item_created",
        item: { title: "after the import" },
      });
      await stream.cancel();
    });
  });

  test("a re-import that changes nothing adds no second row", async () => {
    const payload = importPayload("c", "carried over", [noted]);
    const id = await importProject(payload);
    await importProject(payload);
    const feed = await memberFeed("c", id);
    expect(
      feed.items.filter((e) => e.kind === "product_imported"),
    ).toHaveLength(1);
  });
});

test("a member with no product gets an empty feed and no product or project filters", async () => {
  inviteEmail("none@example.com");
  const cookie = await signInWithEmail("none@example.com");
  const feed = await get<FeedView>("/feed", cookie);
  expect(feed.items).toEqual([]);
  expect(feed.filters.products).toEqual([]);
  expect(feed.filters.projects).toEqual([]);
  expect((await get<MeView>("/me", cookie)).products).toEqual([]);
});
