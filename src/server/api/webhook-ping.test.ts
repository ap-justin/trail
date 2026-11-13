import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect, test } from "vitest";
import {
  createPingLimiter,
  PING_LIMIT,
  PING_WINDOW_MS,
} from "../service/webhooks.js";
import { setupTestApp } from "../test-app.js";

const draining = new AbortController();
// a receiver that answers only when told to; a held ping waits on its signal like a real request
let hold: Promise<void> | null = null;
let held = 0;
const { app, bot, request, addProject } = setupTestApp({
  webhooks: {
    signal: draining.signal,
    transport: async ({ signal }) => {
      if (hold) {
        held++;
        await new Promise((_, fail) =>
          signal?.addEventListener("abort", () => fail(signal.reason)),
        );
      }
      return { status: 200 };
    },
  },
});
const project = addProject("ping");
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

async function newWebhook(path: string) {
  const res = await request("POST", "/api/v1/webhooks", {
    json: {
      url: `https://bot.example.com/${path}`,
      secret: "whsec_ping_0123456789abcdef",
      projects: [project.key],
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as Body).id as string;
}
const ping = (id: string) => request("POST", `/api/v1/webhooks/${id}/ping`);

test("a webhook takes five pings a minute; the sixth is a 429 saying when to retry", async () => {
  const id = await newWebhook("limit");
  for (let i = 0; i < PING_LIMIT; i++) {
    expect((await ping(id)).status, `ping ${i + 1}`).toBe(200);
  }
  const refused = await ping(id);
  expect(refused.status).toBe(429);
  const wait = Number(refused.headers.get("retry-after"));
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThanOrEqual(60);
  const { error } = (await refused.json()) as Body;
  expect(error.code).toBe("rate_limited");
  expect(error.message).toContain(id);
  expect(error.message).toContain(`${wait} seconds`);
  expect((await ping(id)).status).toBe(429);

  // the limit is per webhook, and the webhook's own reads and writes are not pings
  expect((await ping(await newWebhook("limit-other"))).status).toBe(200);
  expect((await request("GET", `/api/v1/webhooks/${id}`)).status).toBe(200);
});

test("a ping over MCP counts against the same limit and is refused as rate_limited", async () => {
  const id = await newWebhook("limit-mcp");
  const client = new Client({ name: "trail-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://trail.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${bot.key}` } },
      fetch: async (url, init) => app.request(String(url), init),
    }),
  );
  clients.push(client);
  const test_ = async () => {
    const result = await client.callTool({
      name: "test_webhook",
      arguments: { webhookId: id },
    });
    const [first] = result.content as { text: string }[];
    return { isError: result.isError === true, text: first?.text ?? "" };
  };
  for (let i = 0; i < PING_LIMIT - 1; i++) {
    expect((await test_()).isError).toBe(false);
  }
  expect((await ping(id)).status).toBe(200);
  const refused = await test_();
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/^rate_limited: .*try again in \d+ seconds/);
});

test("the limiter forgets a ping after the window and forgets idle webhooks", () => {
  let clock = 1_000_000;
  const limiter = createPingLimiter(() => clock);
  for (let i = 0; i < PING_LIMIT; i++) {
    expect(limiter.take("w")).toBeNull();
    clock += 1_000;
  }
  // the oldest ping was 5 seconds ago, so its slot frees 55 seconds from now
  expect(limiter.take("w")).toBe(55);
  clock += 54_000;
  expect(limiter.take("w")).toBe(1);
  clock += 1_000;
  expect(limiter.take("w")).toBeNull();
  // the take just above recorded a ping; the oldest left in the window is the second one, so a slot frees in 1 second
  expect(limiter.take("w")).toBe(1);
  clock += 120_000;
  for (let i = 0; i < PING_LIMIT; i++) expect(limiter.take("w")).toBeNull();
  expect(limiter.take("w")).not.toBeNull();
});

test("a webhook still inside its window keeps its limit when the idle sweep runs", () => {
  let clock = 0;
  const limiter = createPingLimiter(() => clock);
  limiter.take("busy");
  for (let i = 0; i < 1000; i++) limiter.take(`idle-${i}`);
  clock = 30_000;
  for (let i = 0; i < PING_LIMIT - 1; i++) limiter.take("busy");
  // the first busy ping is now 61 seconds old, the other four 31; every idle webhook has gone quiet
  clock = 61_000;
  // 1002 webhooks are tracked, so this ping sweeps
  expect(limiter.take("trigger")).toBeNull();
  expect(limiter.take("busy")).toBeNull();
  expect(limiter.take("busy")).toBe(
    Math.ceil((30_000 + PING_WINDOW_MS - clock) / 1000),
  );
});

test("a shutdown cuts a ping in flight, and the answer says why", async () => {
  const id = await newWebhook("shutdown");
  hold = Promise.resolve();
  const inFlight = ping(id);
  for (let i = 0; i < 100 && held === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(held).toBe(1);
  draining.abort();
  const res = await inFlight;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    delivered: false,
    status: null,
    error: "trail is shutting down: test again in a minute",
  });
});

test("a ping that arrives after shutdown began is never sent, and the answer says why", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let sent = 0;
  const late = setupTestApp({
    webhooks: {
      signal: aborted.signal,
      transport: async () => {
        sent++;
        return { status: 200 };
      },
    },
  });
  const lateProject = late.addProject("late");
  const created = await late.request("POST", "/api/v1/webhooks", {
    json: {
      url: "https://bot.example.com/late",
      secret: "whsec_ping_0123456789abcdef",
      projects: [lateProject.key],
    },
  });
  const id = ((await created.json()) as Body).id as string;
  const res = await late.request("POST", `/api/v1/webhooks/${id}/ping`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    delivered: false,
    status: null,
    error: "trail is shutting down: test again in a minute",
  });
  expect(sent).toBe(0);
});
