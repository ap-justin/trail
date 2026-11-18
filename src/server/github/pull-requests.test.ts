import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { createPullRequests } from "./pull-requests.js";

const MINUTE = 60_000;
const TOKEN = "ghp_madeUpTestTokenValue123";

let clock = Date.parse("2026-11-18T09:00:00.000Z");

type Answer = () => Response | Promise<Response>;
/** What the fake GitHub answers per API url; an unknown url is a 404. */
const answers = new Map<string, Answer>();
/** Every request the refresher sent, in order. */
const sent: Request[] = [];

const { request, pullRequests } = setupTestApp({
  pullRequests: {
    token: TOKEN,
    now: () => clock,
    fetch: async (input, init) => {
      const req = new Request(input, init);
      sent.push(req);
      return (
        answers.get(req.url) ?? (() => new Response(null, { status: 404 }))
      )();
    },
  },
});

let productId = "";
beforeAll(async () => {
  const res = await request("POST", "/api/v1/products", {
    json: { key: projectKey(), name: "pulls" },
  });
  productId = ((await res.json()) as { id: string }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// a day on: earlier tests' links leave the read window and the per-minute count
beforeEach(() => {
  clock += 25 * 60 * MINUTE;
});

let pulls = 0;
/** A made-up pull request url, a fresh number each call. */
const pullUrl = (repo = "widget") =>
  `https://github.com/example-org/${repo}/pull/${++pulls}`;
const apiUrl = (url: string) =>
  url.replace(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//,
    "https://api.github.com/repos/$1/$2/pulls/",
  );
const answer = (url: string, body: unknown, status = 200) =>
  answers.set(apiUrl(url), () => Response.json(body, { status }));

type Link = { url: string; title: string; pr?: unknown };

async function itemWith(urls: string[]) {
  const res = await request("POST", "/api/v1/items", {
    json: {
      type: "todo",
      product: productId,
      title: "links",
      links: urls.map((url) => ({ url })),
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

async function linksOf(key: string): Promise<Link[]> {
  const res = await request("GET", `/api/v1/items/${key}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { links: Link[] }).links;
}

const sentFor = (url: string) => sent.filter((r) => r.url === apiUrl(url));

test("a pull request link reads pr null before its first fetch; other links have no pr", async () => {
  const pr = pullUrl();
  const key = await itemWith([pr, "https://example.com/spec"]);
  expect(await linksOf(key)).toEqual([
    { url: pr, title: pr, pr: null },
    { url: "https://example.com/spec", title: "https://example.com/spec" },
  ]);
});

test("after a refresh each pull request link shows its state: open, draft, merged or closed", async () => {
  const [open, draft, merged, mergedAt, closed] = [
    pullUrl(),
    pullUrl(),
    pullUrl(),
    pullUrl(),
    pullUrl(),
  ] as [string, string, string, string, string];
  answer(open, { state: "open", draft: false, merged: false });
  answer(draft, { state: "open", draft: true, merged: false });
  answer(merged, { state: "closed", merged: true });
  answer(mergedAt, { state: "closed", merged_at: "2026-11-18T08:00:00Z" });
  answer(closed, { state: "closed", merged: false, merged_at: null });
  const key = await itemWith([open, draft, merged, mergedAt, closed]);
  await linksOf(key);
  await pullRequests.tick();
  const checkedAt = new Date(clock).toISOString();
  expect((await linksOf(key)).map((l) => l.pr)).toEqual(
    ["open", "draft", "merged", "merged", "closed"].map((state) => ({
      state,
      checkedAt,
    })),
  );
  const [first] = sentFor(open);
  expect(first?.headers.get("accept")).toBe("application/vnd.github+json");
  expect(first?.headers.get("user-agent")).toBeTruthy();
  expect(first?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
});

test("a link in any case matches its pull request", async () => {
  const pr = pullUrl("Widget");
  answer(pr.toLowerCase(), { state: "open" });
  const upper = pr.replace("example-org", "Example-Org");
  const key = await itemWith([upper]);
  await linksOf(key);
  await pullRequests.tick();
  expect((await linksOf(key))[0]).toEqual({
    url: upper,
    title: upper,
    pr: { state: "open", checkedAt: new Date(clock).toISOString() },
  });
});

/** An item with one pull request link, read and refreshed once to `state` at the current clock. */
async function refreshedItem(state = "open") {
  const pr = pullUrl();
  answer(pr, { state });
  const key = await itemWith([pr]);
  await linksOf(key);
  await pullRequests.tick();
  return { pr, key, checkedAt: new Date(clock).toISOString() };
}

test("a read answers the cached state while a refresh is still waiting on GitHub", async () => {
  const { pr, key, checkedAt } = await refreshedItem("open");
  clock += 11 * MINUTE;
  let release: (res: Response) => void = () => {};
  answers.set(apiUrl(pr), () => new Promise((done) => (release = done)));
  await linksOf(key);
  const refreshing = pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(2);
  expect((await linksOf(key))[0]?.pr).toEqual({ state: "open", checkedAt });
  release(Response.json({ state: "closed", merged: true }));
  await refreshing;
  expect((await linksOf(key))[0]?.pr).toEqual({
    state: "merged",
    checkedAt: new Date(clock).toISOString(),
  });
});

test("the state is refreshed once it is over 10 minutes old, not before", async () => {
  const { pr, key } = await refreshedItem("open");
  clock += 10 * MINUTE;
  await linksOf(key);
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(1);
  clock += 1;
  await linksOf(key);
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(2);
});

test("a failed fetch keeps the old state and backs off 2^failures minutes", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { pr, key, checkedAt } = await refreshedItem("open");
  answers.set(apiUrl(pr), () => new Response("oops", { status: 502 }));
  clock += 11 * MINUTE;
  await linksOf(key);
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(2);
  expect((await linksOf(key))[0]?.pr).toEqual({ state: "open", checkedAt });

  // one failure: 2 minutes
  clock += 2 * MINUTE - 1;
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(2);
  clock += 1;
  answers.set(apiUrl(pr), () => {
    throw new TypeError("fetch failed");
  });
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(3);

  // two failures: 4 minutes; then an answer that isn't a pull request is a failure too
  answer(pr, { message: "not a pull" });
  clock += 4 * MINUTE - 1;
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(3);
  clock += 1;
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(4);
  expect((await linksOf(key))[0]?.pr).toEqual({ state: "open", checkedAt });

  // a success clears the backoff
  answer(pr, { state: "closed", merged: false });
  clock += 8 * MINUTE;
  await pullRequests.tick();
  expect((await linksOf(key))[0]?.pr).toMatchObject({ state: "closed" });
});

test("a pull request no item has shown in the last day is not refreshed", async () => {
  const { pr } = await refreshedItem("open");
  clock += 24 * 60 * MINUTE + 1;
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(1);
});

test("with a token, at most 20 fetches start in a minute", async () => {
  const urls = Array.from({ length: 25 }, () => pullUrl());
  for (const url of urls) answer(url, { state: "open" });
  const key = await itemWith(urls);
  await linksOf(key);
  const fetched = () => urls.filter((u) => sentFor(u).length > 0).length;
  await pullRequests.tick();
  expect(fetched()).toBe(20);
  clock += MINUTE - 1;
  await pullRequests.tick();
  expect(fetched()).toBe(20);
  clock += 1;
  await pullRequests.tick();
  expect(fetched()).toBe(25);
});

test("the token reaches GitHub only, never a log line or a response", async () => {
  const logged: unknown[] = [];
  const spies = (["log", "info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args) => {
      logged.push(...args);
    }),
  );
  try {
    const failing = [pullUrl(), pullUrl(), pullUrl()] as [
      string,
      string,
      string,
    ];
    answers.set(apiUrl(failing[0]), () => new Response(TOKEN, { status: 401 }));
    answers.set(apiUrl(failing[1]), () => {
      throw new Error(`refused ${TOKEN}`);
    });
    const key = await itemWith(failing);
    await linksOf(key);
    await pullRequests.tick();
    const res = await request("GET", `/api/v1/items/${key}`);
    expect(sentFor(failing[0])[0]?.headers.get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(logged.length).toBeGreaterThan(0);
    expect(
      logged
        .map((l) =>
          l instanceof Error ? `${l.message} ${l.stack}` : String(l),
        )
        .join("\n"),
    ).not.toContain(TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("a read still answers when its write to the cache fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const db = openDatabase(":memory:");
  migrate(db);
  const states = createPullRequests({
    db,
    now: () => clock,
    fetch: async () => Response.json({ state: "open" }),
  });
  const pr = pullUrl();
  states.read([pr]);
  await states.tick();
  db.$client.exec(
    "create trigger refuse before update on github_pull_request begin select raise(abort, 'read-only'); end",
  );
  clock += MINUTE;
  expect(states.read([pr, "https://example.com"])).toEqual(
    new Map([[pr, { state: "open", checkedAt: new Date(clock - MINUTE) }]]),
  );
  expect(console.error).toHaveBeenCalled();
  db.$client.close();
});
