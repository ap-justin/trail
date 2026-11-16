import { expect, test } from "vitest";
import { MESSAGES_PER_PAIR } from "../service/messages.js";
import { setupTestApp } from "../test-app.js";

let clock = Date.now();
const { request, addBot } = setupTestApp({ webhooks: { now: () => clock } });

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;
const as =
  (key: string) =>
  async (
    method: string,
    path: string,
    json?: unknown,
    headers?: Record<string, string>,
  ) => {
    const res = await request(method, `/api/v1${path}`, { key, json, headers });
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as Body,
    };
  };

let n = 0;
function bots() {
  n++;
  const alpha = addBot(`alpha-rest${n}`);
  const beta = addBot(`beta-rest${n}`);
  const gamma = addBot(`gamma-rest${n}`);
  return {
    alpha: { ...alpha, api: as(alpha.key) },
    beta: { ...beta, api: as(beta.key) },
    gamma: { ...gamma, api: as(gamma.key) },
  };
}

test("REST sends, lists, threads and marks read, and whoami counts the unread", async () => {
  const { alpha, beta } = bots();
  const sent = await alpha.api("POST", "/messages", {
    to: beta.actor.displayName,
    text: "Is ATL-3 done?",
  });
  expect(sent.status).toBe(201);
  expect(sent.body.thread).toEqual({
    id: sent.body.message.id,
    messageCount: 1,
  });
  expect((await beta.api("GET", "/whoami")).body.unreadMessages).toBe(1);

  const inbox = await beta.api("GET", "/messages");
  expect(inbox.status).toBe(200);
  expect(inbox.body.items.map((m: Body) => m.preview)).toEqual([
    "Is ATL-3 done?",
  ]);

  const reply = await beta.api("POST", "/messages", {
    replyTo: sent.body.message.id,
    text: "Yes.",
  });
  expect(reply.status).toBe(201);
  const thread = await alpha.api(
    "GET",
    `/messages/${reply.body.message.id}/thread`,
  );
  expect(thread.status).toBe(200);
  expect(thread.body.items.map((m: Body) => m.text)).toEqual([
    "Is ATL-3 done?",
    "Yes.",
  ]);

  const marked = await beta.api("POST", "/messages/read", {
    messageIds: [sent.body.message.id],
  });
  expect(marked.status).toBe(200);
  expect(marked.body.results[0].result).toBe("read");
  expect((await beta.api("GET", "/messages")).body.items).toEqual([]);
  expect((await beta.api("GET", "/messages?all=true")).body.items).toHaveLength(
    1,
  );
  expect((await beta.api("GET", "/whoami")).body.unreadMessages).toBe(0);
});

test("a thread outside your conversations is a 404, never a 403", async () => {
  const { alpha, beta, gamma } = bots();
  const sent = await alpha.api("POST", "/messages", {
    to: beta.actor.id,
    text: "x",
  });
  const outside = await gamma.api(
    "GET",
    `/messages/${sent.body.message.id}/thread`,
  );
  expect(outside.status).toBe(404);
  expect(outside.body.error.code).toBe("not_found");
  const reply = await gamma.api("POST", "/messages", {
    replyTo: sent.body.message.id,
    text: "x",
  });
  expect(reply.status).toBe(404);
});

test("refusals carry their status and code: 404 unknown bot, 422 yourself, 409 no reply wanted, 413 too long", async () => {
  const { alpha, beta } = bots();
  const unknown = await alpha.api("POST", "/messages", {
    to: "no-such-bot",
    text: "x",
  });
  expect([unknown.status, unknown.body.error.code]).toEqual([404, "not_found"]);
  const self = await alpha.api("POST", "/messages", {
    to: alpha.actor.id,
    text: "x",
  });
  expect([self.status, self.body.error.code]).toEqual([
    422,
    "validation_failed",
  ]);
  const fyi = await alpha.api("POST", "/messages", {
    to: beta.actor.id,
    text: "FYI",
    expectsReply: false,
  });
  const refused = await beta.api("POST", "/messages", {
    replyTo: fyi.body.message.id,
    text: "ok",
  });
  expect([refused.status, refused.body.error.code]).toEqual([
    409,
    "no_reply_wanted",
  ]);
  const long = await alpha.api("POST", "/messages", {
    to: beta.actor.id,
    text: "a".repeat(65_537),
  });
  expect([long.status, long.body.error.code]).toEqual([
    413,
    "payload_too_large",
  ]);
  const unknownField = await alpha.api("POST", "/messages", {
    to: beta.actor.id,
    text: "x",
    body: "x",
  });
  expect(unknownField.status).toBe(422);
});

test("past the pair's limit a send is a 429 with Retry-After", async () => {
  const { alpha, beta } = bots();
  clock = Date.now();
  for (let i = 0; i < MESSAGES_PER_PAIR; i++) {
    expect(
      (
        await alpha.api("POST", "/messages", {
          to: beta.actor.id,
          text: `${i}`,
        })
      ).status,
    ).toBe(201);
  }
  const limited = await alpha.api("POST", "/messages", {
    to: beta.actor.id,
    text: "x",
  });
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe("rate_limited");
  expect(limited.headers.get("retry-after")).toBe("600");
});

test("an Idempotency-Key replays the first send", async () => {
  const { alpha, beta } = bots();
  const headers = { "idempotency-key": "run-7-handoff" };
  const body = { to: beta.actor.id, text: "Handing ATL-9 to you." };
  const first = await alpha.api("POST", "/messages", body, headers);
  const again = await alpha.api("POST", "/messages", body, headers);
  expect(again.status).toBe(201);
  expect(again.body).toEqual(first.body);
  expect((await beta.api("GET", "/messages")).body.items).toHaveLength(1);
});

test("mark read takes at most 100 ids, and no key is a 401", async () => {
  const { alpha } = bots();
  const tooMany = await alpha.api("POST", "/messages/read", {
    messageIds: Array.from({ length: 101 }, (_, i) => `m${i}`),
  });
  expect(tooMany.status).toBe(422);
  const anonymous = await request("GET", "/api/v1/messages", { key: null });
  expect(anonymous.status).toBe(401);
});
