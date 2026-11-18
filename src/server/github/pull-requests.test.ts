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

/** Three pull request links on one item, read once, each answered by `answerAll` while it is set. */
async function itemOfThree(answerAll: () => Response) {
  const urls = [pullUrl(), pullUrl(), pullUrl()];
  let current: (() => Response) | null = answerAll;
  for (const url of urls) {
    answers.set(apiUrl(url), () =>
      current ? current() : Response.json({ state: "open" }),
    );
  }
  const key = await itemWith(urls);
  await linksOf(key);
  const fetched = () => urls.reduce((n, u) => n + sentFor(u).length, 0);
  return { key, fetched, answerOpen: () => (current = null) };
}

test("a 429 with retry-after stops all fetching for that long and is not a failure of its pull request", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { key, fetched, answerOpen } = await itemOfThree(
    () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
  );
  await pullRequests.tick();
  expect(fetched()).toBe(1);
  clock += 60_000 - 1;
  await pullRequests.tick();
  expect(fetched()).toBe(1);

  // counted as a failure, the limited pull request would wait 2 minutes more
  answerOpen();
  clock += 1;
  await pullRequests.tick();
  expect(fetched()).toBe(4);
  expect((await linksOf(key)).map((l) => l.pr)).toEqual(
    Array(3).fill({ state: "open", checkedAt: new Date(clock).toISOString() }),
  );
});

test("a 403 with no requests remaining stops all fetching until x-ratelimit-reset", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const reset = clock + 7 * MINUTE;
  const { fetched, answerOpen } = await itemOfThree(
    () =>
      new Response("API rate limit exceeded", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset / 1000),
        },
      }),
  );
  await pullRequests.tick();
  expect(fetched()).toBe(1);
  answerOpen();
  clock = reset - 1;
  await pullRequests.tick();
  expect(fetched()).toBe(1);
  clock = reset;
  await pullRequests.tick();
  expect(fetched()).toBe(4);
});

test("a 429 naming no wait stops all fetching for a minute", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { fetched, answerOpen } = await itemOfThree(
    () => new Response(null, { status: 429 }),
  );
  await pullRequests.tick();
  answerOpen();
  clock += MINUTE - 1;
  await pullRequests.tick();
  expect(fetched()).toBe(1);
  clock += 1;
  await pullRequests.tick();
  expect(fetched()).toBe(4);
});

test("a 403 that names no rate limit fails its own pull request only", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { fetched } = await itemOfThree(
    () => new Response(null, { status: 403 }),
  );
  await pullRequests.tick();
  expect(fetched()).toBe(3);
});

test("a pull request no item has shown in the last day is not refreshed", async () => {
  const { pr } = await refreshedItem("open");
  clock += 24 * 60 * MINUTE + 1;
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(1);
});

test("a read an hour or more after the last stamp extends the day a pull request is refreshed for", async () => {
  const { pr, key } = await refreshedItem("open");
  clock += 60 * MINUTE;
  await linksOf(key);
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(2);
  clock += 24 * 60 * MINUTE - 1;
  await pullRequests.tick();
  expect(sentFor(pr)).toHaveLength(3);
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

test("a read within the hour of a pull request's last stamp writes nothing", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const db = openDatabase(":memory:");
  migrate(db);
  const states = createPullRequests({ db, now: () => clock });
  const pr = pullUrl();
  states.read([pr]);
  db.$client.exec(
    "create trigger refuse before update on github_pull_request begin select raise(abort, 'read-only'); end",
  );
  clock += 59 * MINUTE;
  expect(states.read([pr])).toEqual(new Map([[pr, null]]));
  expect(errors).not.toHaveBeenCalled();
  db.$client.close();
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
  clock += 60 * MINUTE;
  expect(states.read([pr, "https://example.com"])).toEqual(
    new Map([
      [pr, { state: "open", checkedAt: new Date(clock - 60 * MINUTE) }],
    ]),
  );
  expect(console.error).toHaveBeenCalled();
  db.$client.close();
});

/** A refresher on its own database, so stop() and the clock belong to the test. */
function isolated(fetchImpl: typeof fetch, token?: string) {
  const db = openDatabase(":memory:");
  migrate(db);
  const states = createPullRequests({
    db,
    token,
    now: () => clock,
    fetch: fetchImpl,
  });
  const rowOf = (url: string) =>
    db.$client
      .prepare(
        "select state, failures, attempted_at as attemptedAt from github_pull_request where url = ?",
      )
      .get(url) as {
      state: string | null;
      failures: number;
      attemptedAt: number | null;
    };
  return { db, states, rowOf };
}

/** A fetch that never answers on its own and rejects when its signal aborts. */
function hangingFetch(calls: string[]): typeof fetch {
  return (input, init) => {
    calls.push(String(input));
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      );
    });
  };
}

test("a fetch GitHub never answers ends after 10 seconds, counts as a failure and frees later passes", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // AbortSignal.timeout runs on Node's own timers, which fake timers don't reach
  const expiry = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(expiry.signal);
  const calls: string[] = [];
  const { db, states, rowOf } = isolated(hangingFetch(calls));
  const pr = pullUrl();
  states.read([pr]);
  const pass = states.tick();
  expect(timeout).toHaveBeenCalledWith(10_000);
  expiry.abort(new DOMException("timed out", "TimeoutError"));
  await pass;
  expect(rowOf(pr).failures).toBe(1);
  expect(rowOf(pr).state).toBeNull();

  clock += 2 * MINUTE;
  timeout.mockReturnValue(new AbortController().signal);
  const next = states.tick();
  expect(calls).toHaveLength(2);
  await states.stop();
  await next;
  db.$client.close();
});

test("stop() cuts a fetch in flight and records no failure for it", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: string[] = [];
  const { db, states, rowOf } = isolated(hangingFetch(calls));
  const pr = pullUrl();
  states.read([pr]);
  const pass = states.tick();
  expect(calls).toHaveLength(1);
  await states.stop();
  await pass;
  expect(rowOf(pr)).toEqual({ state: null, failures: 0, attemptedAt: null });
  expect(warn).not.toHaveBeenCalled();

  clock += 25 * MINUTE;
  await states.tick();
  expect(calls).toHaveLength(1);
  db.$client.close();
});

test("a fetch that fails on its own is recorded, unlike one cut by stop()", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { db, states, rowOf } = isolated(async () => {
    throw new TypeError("fetch failed");
  });
  const pr = pullUrl();
  states.read([pr]);
  await states.tick();
  expect(rowOf(pr).failures).toBe(1);
  db.$client.close();
});

test("the backoff after six failures in a row stays at 60 minutes", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: string[] = [];
  const { db, states, rowOf } = isolated(async (input) => {
    calls.push(String(input));
    return new Response(null, { status: 502 });
  });
  const pr = pullUrl();
  states.read([pr]);
  await states.tick();
  for (const minutes of [2, 4, 8, 16, 32]) {
    clock += minutes * MINUTE - 1;
    await states.tick();
    const before = calls.length;
    clock += 1;
    await states.tick();
    expect(calls.length).toBe(before + 1);
  }
  expect(rowOf(pr).failures).toBe(6);

  // 2^6 = 64 minutes uncapped
  clock += 60 * MINUTE - 1;
  await states.tick();
  expect(calls).toHaveLength(6);
  clock += 1;
  await states.tick();
  expect(calls).toHaveLength(7);

  // 2^7 = 128 minutes uncapped
  clock += 60 * MINUTE;
  await states.tick();
  expect(calls).toHaveLength(8);
  db.$client.close();
});

test("a 200 whose body is not JSON fails its pull request and backs off", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: string[] = [];
  const { db, states, rowOf } = isolated(async (input) => {
    calls.push(String(input));
    return new Response("<html>maintenance</html>", { status: 200 });
  });
  const pr = pullUrl();
  states.read([pr]);
  await states.tick();
  expect(rowOf(pr)).toMatchObject({ state: null, failures: 1 });
  expect(states.read([pr]).get(pr)).toBeNull();

  clock += 2 * MINUTE - 1;
  await states.tick();
  expect(calls).toHaveLength(1);
  clock += 1;
  await states.tick();
  expect(calls).toHaveLength(2);
  db.$client.close();
});

test("the most recently read pull request is fetched first", async () => {
  const calls: string[] = [];
  const { db, states } = isolated(async (input) => {
    calls.push(String(input));
    return Response.json({ state: "open" });
  }, TOKEN);
  const [older, newer] = [pullUrl(), pullUrl()] as [string, string];
  states.read([older]);
  clock += MINUTE;
  states.read([newer]);
  await states.tick();
  expect(calls).toEqual([apiUrl(newer), apiUrl(older)]);
  db.$client.close();
});

test("a tick while a pass is running shares that pass and starts no second fetch", async () => {
  const calls: string[] = [];
  let release: (res: Response) => void = () => {};
  const { db, states } = isolated((input) => {
    calls.push(String(input));
    return new Promise((done) => (release = done));
  }, TOKEN);
  const pr = pullUrl();
  states.read([pr]);
  const first = states.tick();
  const second = states.tick();
  expect(second).toBe(first);
  release(Response.json({ state: "open" }));
  await Promise.all([first, second]);
  expect(calls).toEqual([apiUrl(pr)]);

  // the pass is over: a later tick is a new pass
  clock += 11 * MINUTE;
  states.read([pr]);
  const third = states.tick();
  expect(third).not.toBe(first);
  release(Response.json({ state: "open" }));
  await third;
  expect(calls).toHaveLength(2);
  db.$client.close();
});

test("a repo named only with dots is no pull request link and is never fetched", async () => {
  const calls: string[] = [];
  const { db, states } = isolated(async (input) => {
    calls.push(String(input));
    return Response.json({ state: "open" });
  }, TOKEN);
  const climbing = [".", "..", "..."].map(
    (repo) => `https://github.com/example-org/${repo}/pull/1`,
  );
  const dotted = "https://github.com/example-org/.github/pull/1";
  const read = states.read([...climbing, dotted]);
  expect([...read.keys()]).toEqual([dotted]);
  await states.tick();
  expect(calls).toEqual([
    "https://api.github.com/repos/example-org/.github/pulls/1",
  ]);
  db.$client.close();
});
