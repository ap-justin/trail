import { beforeEach, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const MINUTE = 60_000;
let clock = Date.parse("2026-11-18T09:00:00.000Z");

/** What the fake GitHub answers per API url; an unknown url is a 404. */
const answers = new Map<string, () => Response | Promise<Response>>();

const { request, signIn, owner, addProject, addMember, pullRequests } =
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

async function itemWith(urls: string[]) {
  const p = addProject("Pulls");
  return seed.item(p.key, "issue", { links: urls.map((url) => ({ url })) });
}

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
  answers.set(apiUrl(pr), () => new Promise((done) => (release = done)));
  await linksOf(key);
  const refreshing = pullRequests.tick();
  expect((await linksOf(key))[0]?.pr).toEqual({ state: "open", checkedAt });
  release(Response.json({ state: "closed", merged: true }));
  await refreshing;
  expect((await linksOf(key))[0]?.pr).toEqual({
    state: "merged",
    checkedAt: new Date(clock).toISOString(),
  });
});

test("an item the viewer can't see is the same 404, and the read does not queue its pull request", async () => {
  const pr = pullUrl();
  const fetched: string[] = [];
  answers.set(apiUrl(pr), () => {
    fetched.push(pr);
    return Response.json({ state: "open" });
  });
  const key = await itemWith([pr]);
  // past the day the bot's create answer keeps it refreshed for
  clock += 25 * 60 * MINUTE;
  const outsider = await addMember("outsider", []);
  const { status, body } = await seed.get(`/items/${key}`, outsider);
  expect(status).toBe(404);
  expect(body.error.message).toBe(`no item ${key}`);
  await pullRequests.tick();
  expect(fetched).toEqual([]);
});
