import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { createKey } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

// the app's clock, which stands still until a test moves it
let clock = Date.now();
const { app, db, addBot, addProject } = setupTestApp({
  webhooks: { now: () => clock },
});
const { connect, call, callError } = mcpClients(app);

let bots = 0;
/** Two fresh bots, so no test sees another's messages or rate limit. */
async function pair() {
  const n = ++bots;
  const alpha = addBot(`alpha${n}`);
  const beta = addBot(`beta${n}`);
  return {
    alpha: { ...alpha, client: await connect(alpha.key) },
    beta: { ...beta, client: await connect(beta.key) },
  };
}

test("a message to a bot named in any case lands in its inbox, unread, with the sender", async () => {
  const { alpha, beta } = await pair();
  const sent = await call(alpha.client, "message_bot", {
    to: beta.actor.displayName.toUpperCase(),
    text: "What is the status of the release?",
  });
  expect(sent.message).toMatchObject({
    from: { id: alpha.actor.id, name: alpha.actor.displayName },
    to: { id: beta.actor.id, name: beta.actor.displayName },
    threadId: sent.message.id,
    replyTo: null,
    expectsReply: true,
    text: "What is the status of the release?",
    readAt: null,
  });
  expect(sent.thread).toEqual({ id: sent.message.id, messageCount: 1 });

  const inbox = await call(beta.client, "list_inbox");
  expect(inbox.items).toEqual([
    {
      id: sent.message.id,
      from: { id: alpha.actor.id, name: alpha.actor.displayName },
      threadId: sent.message.id,
      replyTo: null,
      expectsReply: true,
      preview: "What is the status of the release?",
      truncated: false,
      createdAt: sent.message.createdAt,
      readAt: null,
    },
  ]);
  expect(inbox.nextCursor).toBeNull();
  // the sender's own inbox holds nothing it sent
  expect((await call(alpha.client, "list_inbox")).items).toEqual([]);
});

test("a reply joins the thread, which both bots read oldest first, and mark_read empties the unread inbox", async () => {
  const { alpha, beta } = await pair();
  const asked = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "Status of ATL-7?",
  });
  expect((await call(beta.client, "whoami")).unreadMessages).toBe(1);
  // replyTo alone names the recipient: the other bot of the message answered
  const answered = await call(beta.client, "message_bot", {
    replyTo: asked.message.id,
    text: "Merged, deploying now.",
  });
  expect(answered.message).toMatchObject({
    to: { id: alpha.actor.id },
    threadId: asked.message.id,
    replyTo: asked.message.id,
  });
  expect(answered.thread).toEqual({ id: asked.message.id, messageCount: 2 });

  for (const reader of [alpha, beta]) {
    const thread = await call(reader.client, "get_thread", {
      messageId: answered.message.id,
    });
    expect(thread.threadId).toBe(asked.message.id);
    expect(thread.bots.map((b: Body) => b.id)).toEqual([
      alpha.actor.id,
      beta.actor.id,
    ]);
    expect(thread.items.map((m: Body) => m.text)).toEqual([
      "Status of ATL-7?",
      "Merged, deploying now.",
    ]);
  }

  const marked = await call(beta.client, "mark_read", {
    messageIds: [asked.message.id],
  });
  expect(marked.results).toEqual([
    { id: asked.message.id, result: "read", readAt: expect.any(String) },
  ]);
  expect(marked.unreadMessages).toBe(0);
  // marking again changes nothing and says so
  const again = await call(beta.client, "mark_read", {
    messageIds: [asked.message.id],
  });
  expect(again.results[0]).toMatchObject({
    result: "already_read",
    readAt: marked.results[0].readAt,
  });
  expect((await call(beta.client, "list_inbox")).items).toEqual([]);
  const all = await call(beta.client, "list_inbox", { all: true });
  expect(all.items.map((m: Body) => [m.id, m.readAt])).toEqual([
    [asked.message.id, marked.results[0].readAt],
  ]);
  expect((await call(beta.client, "whoami")).unreadMessages).toBe(0);
  // the reply waits in alpha's inbox
  expect(
    (await call(alpha.client, "list_inbox")).items.map((m: Body) => m.id),
  ).toEqual([answered.message.id]);
});

test("a third bot can't see, answer or mark another pair's messages: each is not found", async () => {
  const { alpha, beta } = await pair();
  const gamma = addBot(`gamma${bots}`);
  const outsider = await connect(gamma.key);
  const sent = await call(alpha.client, "message_bot", {
    to: beta.actor.displayName,
    text: "private",
  });
  const missing = `not_found: no message ${sent.message.id} among your messages`;
  expect(
    await callError(outsider, "get_thread", { messageId: sent.message.id }),
  ).toMatch(missing);
  expect(
    await callError(outsider, "message_bot", {
      replyTo: sent.message.id,
      text: "me too",
    }),
  ).toMatch(`not_found: no replyTo message ${sent.message.id}`);
  // a message never seen and a message the caller itself sent read alike
  const own = await call(outsider, "message_bot", {
    to: alpha.actor.id,
    text: "hello",
  });
  expect(
    (
      await call(outsider, "mark_read", {
        messageIds: [sent.message.id, own.message.id, "no-such-id"],
      })
    ).results.map((r: Body) => r.result),
  ).toEqual(["not_found", "not_found", "not_found"]);
  expect((await call(beta.client, "list_inbox")).items[0].readAt).toBeNull();
  expect((await call(outsider, "list_inbox", { all: true })).items).toEqual([]);
});

test("a key limited to one product and the read action still sends, reads and marks its bot's messages", async () => {
  const { alpha, beta } = await pair();
  const product = addProject("Scoped");
  const scoped = await connect(
    createKey(db, beta.actor.id, {
      products: [product.key],
      actions: ["comments"],
    }).key,
  );
  const sent = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "ping",
  });
  expect((await call(scoped, "list_inbox")).items).toHaveLength(1);
  await call(scoped, "get_thread", { messageId: sent.message.id });
  // credited to the key's bot, not the key
  const reply = await call(scoped, "message_bot", {
    replyTo: sent.message.id,
    text: "pong",
  });
  expect(reply.message.from.id).toBe(beta.actor.id);
  await call(scoped, "mark_read", { messageIds: [sent.message.id] });
});

test("a recipient that is a person, unknown or yourself is refused with what to do instead", async () => {
  const { alpha, beta } = await pair();
  const person = db
    .insert(actor)
    .values({ kind: "human", displayName: "Pat Person" })
    .returning()
    .get();
  expect(
    await callError(alpha.client, "message_bot", { to: person.id, text: "hi" }),
  ).toMatch(/is a person, and people can't receive messages.*list_bots/);
  expect(
    await callError(alpha.client, "message_bot", {
      to: "nobody-by-this-name",
      text: "hi",
    }),
  ).toBe(
    "not_found: no bot nobody-by-this-name: the to field takes a bot's name (any case) or id, not its label, and list_bots (GET /api/v1/bots) lists them. To answer a message from list_inbox (GET /api/v1/messages), send replyTo instead, which needs no to field",
  );
  expect(
    await callError(alpha.client, "message_bot", {
      to: alpha.actor.displayName,
      text: "hi",
    }),
  ).toMatch("you can't message yourself");
  expect(await callError(alpha.client, "message_bot", { text: "hi" })).toMatch(
    "to is required",
  );
  // a reply addressed to a bot outside the replied message's conversation
  const gamma = addBot(`gamma-to${bots}`);
  const first = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "hi",
  });
  expect(
    await callError(alpha.client, "message_bot", {
      to: gamma.actor.id,
      replyTo: first.message.id,
      text: "hi",
    }),
  ).toMatch(
    `is in your conversation with ${beta.actor.displayName}, not with ${gamma.actor.displayName}`,
  );
});

test("a reply with an unknown to is told to leave to out, not to send the replyTo it already sent", async () => {
  const { alpha, beta } = await pair();
  const first = await call(beta.client, "message_bot", {
    to: alpha.actor.id,
    text: "hi",
  });
  const refused = await callError(alpha.client, "message_bot", {
    to: "nobody-by-this-name",
    replyTo: first.message.id,
    text: "hi back",
  });
  expect(refused).toBe(
    `not_found: no bot nobody-by-this-name: the to field takes a bot's name (any case) or id, not its label, and list_bots (GET /api/v1/bots) lists them. To answer replyTo message ${first.message.id}, which is in your conversation with ${beta.actor.displayName}, leave to out`,
  );
});

test("a reply to a message sent with expectsReply false is refused, and a new message still goes", async () => {
  const { alpha, beta } = await pair();
  const fyi = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "FYI: deployed.",
    expectsReply: false,
  });
  expect(fyi.message.expectsReply).toBe(false);
  expect((await call(beta.client, "list_inbox")).items[0].expectsReply).toBe(
    false,
  );
  const refused = await callError(beta.client, "message_bot", {
    replyTo: fyi.message.id,
    text: "Thanks!",
  });
  expect(refused).toMatch(
    /^no_reply_wanted: .*the sender asked for no reply.*send a new message \(leave replyTo out\)/,
  );
  // the sender may still follow up on its own message
  await call(alpha.client, "message_bot", {
    replyTo: fyi.message.id,
    text: "Also: rolled back.",
  });
  await call(beta.client, "message_bot", {
    to: alpha.actor.id,
    text: "Saw the deploy; one question.",
  });
});

test("a sender gets 30 messages to one bot per 10 minutes, then a refusal saying when to retry", async () => {
  const { alpha, beta } = await pair();
  const gamma = addBot(`gamma-rate${bots}`);
  clock = Date.now();
  for (let i = 0; i < 30; i++) {
    await call(alpha.client, "message_bot", {
      to: beta.actor.id,
      text: `note ${i}`,
    });
    clock += 1000;
  }
  const refused = await callError(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "one more",
  });
  // the first send went 30 s ago and leaves the 10-minute window after 600 s
  const wait = 570;
  expect(refused).toMatch(`rate_limited: `);
  expect(refused).toMatch(`try again in ${wait} seconds`);
  // the limit is per sender and recipient: other pairs still go
  await call(alpha.client, "message_bot", { to: gamma.actor.id, text: "hi" });
  await call(beta.client, "message_bot", { to: alpha.actor.id, text: "hi" });
  clock += wait * 1000;
  await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "one more",
  });
});

test("a retry with the same idempotency_key returns the first message and sends nothing more", async () => {
  const { alpha, beta } = await pair();
  const args = {
    to: beta.actor.id,
    text: "Run the nightly job?",
    idempotency_key: "run-42-ask",
  };
  const first = await call(alpha.client, "message_bot", args);
  const again = await call(alpha.client, "message_bot", args);
  expect(again).toEqual(first);
  expect((await call(beta.client, "list_inbox")).items).toHaveLength(1);
  expect(
    await callError(alpha.client, "message_bot", { ...args, text: "other" }),
  ).toMatch("idempotency_key_reused");
});

test("text over 64 KiB of UTF-8 is refused naming the limit and the size sent, as is a NUL", async () => {
  const { alpha, beta } = await pair();
  // 3 bytes each in UTF-8: under the limit in characters, over it in bytes
  const text = "€".repeat(21_846);
  const bytes = 65_538;
  expect(Buffer.byteLength(text)).toBe(bytes);
  expect(
    await callError(alpha.client, "message_bot", { to: beta.actor.id, text }),
  ).toMatch(
    `payload_too_large: text is ${bytes} bytes, over the limit of 65536 bytes`,
  );
  const exact = "a".repeat(65_536);
  const sent = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: exact,
  });
  expect(sent.message.text).toBe(exact);
  const entry = (await call(beta.client, "list_inbox")).items[0];
  expect(entry).toMatchObject({ preview: "a".repeat(200), truncated: true });
  expect(
    await callError(alpha.client, "message_bot", {
      to: beta.actor.id,
      text: "a\u0000b",
    }),
  ).toMatch("NUL character");
  expect(
    await callError(alpha.client, "message_bot", {
      to: beta.actor.id,
      text: "  ",
    }),
  ).toMatch("text must not be empty");
});

test("the inbox pages newest first, and a cursor works only with the all it was issued under", async () => {
  const { alpha, beta } = await pair();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(
      (
        await call(alpha.client, "message_bot", {
          to: beta.actor.id,
          text: `m${i}`,
        })
      ).message.id,
    );
  }
  const first = await call(beta.client, "list_inbox", { limit: 2 });
  expect(first.items.map((m: Body) => m.id)).toEqual([ids[2], ids[1]]);
  const second = await call(beta.client, "list_inbox", {
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(second.items.map((m: Body) => m.id)).toEqual([ids[0]]);
  expect(second.nextCursor).toBeNull();
  expect(
    await callError(beta.client, "list_inbox", {
      all: true,
      cursor: first.nextCursor,
    }),
  ).toMatch("cursor was issued for another list or filters");
});

test("a thread pages oldest first to its end, found by its root or any reply, and a cursor works only in its own thread", async () => {
  const { alpha, beta } = await pair();
  const root = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "t1",
  });
  const second = await call(beta.client, "message_bot", {
    replyTo: root.message.id,
    text: "t2",
  });
  const third = await call(alpha.client, "message_bot", {
    replyTo: second.message.id,
    text: "t3",
  });
  const other = await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "another thread",
  });
  const ids = [root, second, third].map((m) => m.message.id);

  // the same thread by its root and by a reply, read by the recipient of the root
  for (const id of [root.message.id, second.message.id, third.message.id]) {
    const whole = await call(beta.client, "get_thread", { messageId: id });
    expect(whole.threadId).toBe(root.message.id);
    expect(whole.bots.map((b: Body) => b.id)).toEqual([
      alpha.actor.id,
      beta.actor.id,
    ]);
    expect(whole.items.map((m: Body) => m.id)).toEqual(ids);
    expect(whole.nextCursor).toBeNull();
  }

  const first = await call(beta.client, "get_thread", {
    messageId: second.message.id,
    limit: 2,
  });
  expect(first.items.map((m: Body) => m.id)).toEqual(ids.slice(0, 2));
  expect(first.nextCursor).not.toBeNull();
  const last = await call(beta.client, "get_thread", {
    messageId: second.message.id,
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(last.items.map((m: Body) => m.id)).toEqual(ids.slice(2));
  expect(last.nextCursor).toBeNull();

  expect(
    await callError(beta.client, "get_thread", {
      messageId: other.message.id,
      cursor: first.nextCursor,
    }),
  ).toMatch("cursor was issued for another list or filters");
});

test("mark_read reports what stays unread, counts a duplicated id once, and takes exactly 100 ids", async () => {
  const { alpha, beta } = await pair();
  const sent: string[] = [];
  for (let i = 0; i < 3; i++) {
    sent.push(
      (
        await call(alpha.client, "message_bot", {
          to: beta.actor.id,
          text: `r${i}`,
        })
      ).message.id,
    );
  }
  const [one, two, three] = sent as [string, string, string];
  const some = await call(beta.client, "mark_read", { messageIds: [one] });
  expect(some.unreadMessages).toBe(2);
  expect((await call(beta.client, "whoami")).unreadMessages).toBe(2);

  const twice = await call(beta.client, "mark_read", {
    messageIds: [two, two],
  });
  expect(twice.results).toEqual([
    { id: two, result: "read", readAt: expect.any(String) },
  ]);
  expect(twice.unreadMessages).toBe(1);

  const hundred = await call(beta.client, "mark_read", {
    messageIds: [three, ...Array.from({ length: 99 }, (_, i) => `ghost${i}`)],
  });
  expect(hundred.results).toHaveLength(100);
  expect(hundred.results[0]).toMatchObject({ id: three, result: "read" });
  expect(hundred.unreadMessages).toBe(0);
  await callError(beta.client, "mark_read", {
    messageIds: Array.from({ length: 101 }, (_, i) => `ghost${i}`),
  });
});

test("an empty or over-long idempotency_key is refused and sends nothing", async () => {
  const { alpha, beta } = await pair();
  for (const idempotency_key of ["", "k".repeat(256)]) {
    await callError(alpha.client, "message_bot", {
      to: beta.actor.id,
      text: "x",
      idempotency_key,
    });
  }
  expect((await call(beta.client, "list_inbox")).items).toEqual([]);
  await call(alpha.client, "message_bot", {
    to: beta.actor.id,
    text: "x",
    idempotency_key: "k".repeat(255),
  });
  expect((await call(beta.client, "list_inbox")).items).toHaveLength(1);
});

test("create_webhook with kind inbox subscribes the bot's inbox, whatever the key's actions", async () => {
  const { beta } = await pair();
  const commentsOnly = await connect(
    createKey(db, beta.actor.id, { actions: ["comments"] }).key,
  );
  const hook = await call(commentsOnly, "create_webhook", {
    kind: "inbox",
    url: `https://beta.example.com/inbox-mcp${bots}`,
    secret: "whsec_inbox_mcp_0123456789",
  });
  expect(hook).toMatchObject({ kind: "inbox", products: [] });
  expect(
    (await call(commentsOnly, "list_webhooks")).items.map((w: Body) => w.id),
  ).toEqual([hook.id]);
});
