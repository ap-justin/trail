import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type Body, mcpClients } from "../mcp/test-client.js";
import { projectKey, setupTestApp } from "../test-app.js";

const MINUTE = 60_000;
let clock = Date.parse("2026-11-18T09:00:00.000Z");

/** Every request the refresher sent, in order; public repos answer open, any other is a 404. */
const sent: Request[] = [];
const { app, bot, request, pullRequests } = setupTestApp({
  pullRequests: {
    now: () => clock,
    fetch: async (input, init) => {
      const req = new Request(input, init);
      sent.push(req);
      return req.url.includes("/repos/example-org/")
        ? Response.json({ state: "open", draft: false })
        : new Response(null, { status: 404 });
    },
  },
});
const { connect, call } = mcpClients(app);

let client: Awaited<ReturnType<typeof connect>>;
let product = "";
beforeAll(async () => {
  client = await connect(bot.key);
  product = (
    await call(client, "create_product", { key: projectKey(), name: "p" })
  ).key;
});

// a day on: earlier tests' links leave the read window and the per-minute count
beforeEach(() => {
  clock += 25 * 60 * MINUTE;
});

let pulls = 0;
const pullUrl = (owner = "example-org") =>
  `https://github.com/${owner}/widget/pull/${++pulls}`;

async function itemWith(urls: string[]) {
  return (
    await call(client, "add_todo", {
      product,
      title: "links",
      links: urls.map((url) => ({ url })),
    })
  ).key as string;
}

const prOf = async (key: string) =>
  ((await call(client, "get_item", { item: key })).links as Body[]).map(
    (l) => l.pr,
  );

test("without a token, one fetch a minute and no Authorization header", async () => {
  const [first, second] = [pullUrl(), pullUrl()];
  const key = await itemWith([first, second]);
  await prOf(key);
  await pullRequests.tick();
  expect(sent.at(-1)?.headers.get("authorization")).toBeNull();
  // which of the two goes first is the refresher's pick
  const states = await prOf(key);
  expect(states).toHaveLength(2);
  expect(states).toEqual(
    expect.arrayContaining([
      null,
      { state: "open", checkedAt: new Date(clock).toISOString() },
    ]),
  );
  const before = sent.length;
  clock += MINUTE - 1;
  await pullRequests.tick();
  expect(sent.length).toBe(before);
  clock += 1;
  await pullRequests.tick();
  expect(sent.length).toBe(before + 1);
  expect(await prOf(key)).not.toContain(null);
});

test("a private repo without a token stays pr null", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const pr = pullUrl("private-org");
    const key = await itemWith([pr]);
    await prOf(key);
    await pullRequests.tick();
    expect(sent.at(-1)?.url).toBe(
      `https://api.github.com/repos/private-org/widget/pulls/${pulls}`,
    );
    expect(await prOf(key)).toEqual([null]);
  } finally {
    warn.mockRestore();
  }
});

test("list_items and the legacy item routes show pr too", async () => {
  const pr = pullUrl();
  const key = await itemWith([pr, "https://example.com/doc"]);
  await prOf(key);
  await pullRequests.tick();
  const expected = [
    {
      url: pr,
      title: pr,
      pr: { state: "open", checkedAt: new Date(clock).toISOString() },
    },
    { url: "https://example.com/doc", title: "https://example.com/doc" },
  ];
  const listed = await call(client, "list_items", { product });
  expect((listed.items as Body[]).find((i) => i.key === key)?.links).toEqual(
    expected,
  );
  const legacy = await request("GET", `/api/v1/issues/${key}`);
  expect(((await legacy.json()) as Body).links).toEqual(expected);
  const legacyList = await request(
    "GET",
    `/api/v1/issues?projectId=${product}`,
  );
  expect(
    ((await legacyList.json()) as { items: Body[] }).items.find(
      (i) => i.key === key,
    )?.links,
  ).toEqual(expected);
});

test("update_item addLinks answers a new pull request link with pr null, and it is fetched next", async () => {
  const key = await itemWith([]);
  const pr = pullUrl();
  const updated = await call(client, "update_item", {
    item: key,
    addLinks: [{ url: pr, title: "the fix" }],
  });
  expect(updated.links).toEqual([{ url: pr, title: "the fix", pr: null }]);
  await pullRequests.tick();
  expect(sent.at(-1)?.url).toBe(
    `https://api.github.com/repos/example-org/widget/pulls/${pulls}`,
  );
  expect(await prOf(key)).toEqual([
    { state: "open", checkedAt: new Date(clock).toISOString() },
  ]);
});
