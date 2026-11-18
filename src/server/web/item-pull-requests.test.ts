import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import { githubPullRequest } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const MINUTE = 60_000;
let clock = Date.parse("2026-11-18T09:00:00.000Z");

/** What the fake GitHub answers per API url; an unknown url is a 404. */
const answers = new Map<string, () => Response | Promise<Response>>();

const { db, request, signIn, owner, addProject, addMember, pullRequests } =
  setupTestApp({
    pullRequests: {
      // with a token, every pull request of a test is fetched in one tick
      token: "ghp_madeUpTestTokenValue123",
      now: () => clock,
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return (
          answers.get(req.url) ?? (() => new Response(null, { status: 404 }))
        )();
      },
    },
  });
const ownerCookie = await signIn(owner);
const seed = webSeed(request);

// a day on: earlier tests' links leave the read window and the per-minute count
beforeEach(() => {
  clock += 25 * 60 * MINUTE;
});

let pulls = 0;
const pullUrl = () => `https://github.com/example-org/widget/pull/${++pulls}`;
const apiUrl = (url: string) =>
  url.replace(
    "https://github.com/example-org/widget/pull/",
    "https://api.github.com/repos/example-org/widget/pulls/",
  );
const answer = (url: string, body: unknown) =>
  answers.set(apiUrl(url), () => Response.json(body));

async function itemWith(urls: string[], p = addProject("Pulls")) {
  return seed.item(p.key, "issue", { links: urls.map((url) => ({ url })) });
}

/** When a read last stamped this pull request's cache row; null with no row. */
const lastRead = (url: string) =>
  db
    .select({ at: githubPullRequest.lastReadAt })
    .from(githubPullRequest)
    .where(eq(githubPullRequest.url, url))
    .get()?.at ?? null;

async function linksOf(key: string, cookie = ownerCookie): Promise<Body[]> {
  const { status, body } = await seed.get(`/items/${key}`, cookie);
  expect(status).toBe(200);
  return body.links;
}

test("a pull request link reads pr null before its first fetch; other links have no pr key", async () => {
  const pr = pullUrl();
  const key = await itemWith([pr, "https://example.com/spec"]);
  const links = await linksOf(key);
  expect(links).toEqual([
    { url: pr, title: pr, pr: null },
    { url: "https://example.com/spec", title: "https://example.com/spec" },
  ]);
  expect(links[1]).not.toHaveProperty("pr");
});

test("after a refresh each pull request link shows its state: open, draft, merged or closed", async () => {
  const [open, draft, merged, closed] = [
    pullUrl(),
    pullUrl(),
    pullUrl(),
    pullUrl(),
  ] as [string, string, string, string];
  answer(open, { state: "open", draft: false, merged: false });
  answer(draft, { state: "open", draft: true, merged: false });
  answer(merged, { state: "closed", merged: true });
  answer(closed, { state: "closed", merged: false, merged_at: null });
  const key = await itemWith([open, draft, merged, closed]);
  await linksOf(key);
  await pullRequests.tick();
  const checkedAt = new Date(clock).toISOString();
  expect((await linksOf(key)).map((l) => l.pr)).toEqual(
    ["open", "draft", "merged", "closed"].map((state) => ({
      state,
      checkedAt,
    })),
  );
});

test("a read answers the cached state while a refresh is still waiting on GitHub", async () => {
  const pr = pullUrl();
  answer(pr, { state: "open" });
  const key = await itemWith([pr]);
  await linksOf(key);
  await pullRequests.tick();
  const checkedAt = new Date(clock).toISOString();
  clock += 11 * MINUTE;
  let release: (res: Response) => void = () => {};
  let entered: () => void = () => {};
  const fetchEntered = new Promise<void>((resolve) => (entered = resolve));
  answers.set(apiUrl(pr), () => {
    entered();
    return new Promise((done) => (release = done));
  });
  await linksOf(key);
  const refreshing = pullRequests.tick();
  await fetchEntered;
  expect((await linksOf(key))[0]?.pr).toEqual({ state: "open", checkedAt });
  release(Response.json({ state: "closed", merged: true }));
  await refreshing;
  expect((await linksOf(key))[0]?.pr).toEqual({
    state: "merged",
    checkedAt: new Date(clock).toISOString(),
  });
});

test("a member of the item's project reads its pull request state, and the read keeps the link refreshed", async () => {
  const pr = pullUrl();
  answer(pr, { state: "open", draft: true });
  const p = addProject("Shared");
  const key = await itemWith([pr], p);
  const member = await addMember("pr-reader", [p.id]);
  await pullRequests.tick();
  const created = lastRead(pr);
  clock += 2 * 60 * MINUTE;
  expect((await linksOf(key, member))[0]?.pr).toEqual({
    state: "draft",
    checkedAt: new Date(clock - 2 * 60 * MINUTE).toISOString(),
  });
  expect(lastRead(pr)?.getTime()).toBe(clock);
  expect(created?.getTime()).toBeLessThan(clock);
});

test("an item the viewer can't see is the same 404, and the read leaves its pull request unstamped", async () => {
  const pr = pullUrl();
  const key = await itemWith([pr]);
  const stamped = lastRead(pr);
  expect(stamped).not.toBeNull();
  // an hour on: a permitted read restamps the row (the member test above)
  clock += 60 * MINUTE;
  const outsider = await addMember("outsider", []);
  const { status, body } = await seed.get(`/items/${key}`, outsider);
  expect(status).toBe(404);
  expect(body.error.message).toBe(`no item ${key}`);
  expect(lastRead(pr)).toEqual(stamped);
});
