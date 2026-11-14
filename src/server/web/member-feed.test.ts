import { describe, expect, test } from "vitest";
import type { FeedView, MeView } from "../../shared/schemas.js";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { request, addProject, addBot, addMember, inviteEmail, signInWithEmail } =
  setupTestApp();

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
      expect(feed.items.map((e) => e.project.key)).toHaveLength(6);
      expect(new Set(feed.items.map((e) => e.project.key))).toEqual(
        new Set(mine.map((p) => p.key)),
      );
      expect(feed.items.map((e) => e.project.key)).not.toContain(other.key);
      expect(feed.filters.projects.map((p) => p.key).sort()).toEqual(
        mine.map((p) => p.key).sort(),
      );
      expect(feed.filters.actors.map((a) => a.name)).toEqual([`filer-${kind}`]);

      const me = await get<MeView>("/me", cookie);
      expect(me.projects?.map((p) => p.key).sort()).toEqual(
        mine.map((p) => p.key).sort(),
      );
    });
  }
});

test("a member of an imported project sees the import in the feed", async () => {
  const res = await request("POST", "/api/v1/import", {
    json: {
      externalRef: "LIN-1",
      key: "IMPF",
      name: "Imported",
      issues: [
        {
          externalRef: "lin-1",
          title: "carried over",
          status: "Todo",
          createdAt: "2026-01-02T03:04:05.000Z",
          comments: [
            {
              externalRef: "lin-c1",
              body: "noted",
              createdAt: "2026-01-03T00:00:00.000Z",
            },
          ],
        },
      ],
    },
  });
  expect(res.status).toBe(200);
  const { project } = (await res.json()) as { project: { id: string } };
  inviteEmail("imp@example.com", [project.id]);
  const feed = await get<FeedView>(
    "/feed",
    await signInWithEmail("imp@example.com"),
  );
  expect(feed.items).toMatchObject([
    {
      kind: "project_imported",
      project: { key: "IMPF" },
      imported: { issues: 1, comments: 1 },
    },
  ]);
});

test("a member with no project gets an empty feed and no project filters", async () => {
  inviteEmail("none@example.com");
  const cookie = await signInWithEmail("none@example.com");
  const feed = await get<FeedView>("/feed", cookie);
  expect(feed.items).toEqual([]);
  expect(feed.filters.projects).toEqual([]);
  expect((await get<MeView>("/me", cookie)).projects).toEqual([]);
});
