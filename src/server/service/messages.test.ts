import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";
import { NotFoundError } from "./errors.js";
import { createService } from "./index.js";

const { db, bus, webhooks, addBot } = setupTestApp();
const service = createService({ db, bus, webhooks });

type Bot = ReturnType<typeof addBot>["actor"];
const send = (from: Bot, to: Bot, text: string, replyTo?: string) =>
  service.sendMessage(from, { to: to.id, text, replyTo }).message;

let trios = 0;
/** Three fresh bots and their four messages: the newest conversations, whatever other tests sent before. */
function conversations() {
  const n = ++trios;
  const [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map(
    (name) => addBot(`${name}-op${n}`).actor,
  ) as [Bot, Bot, Bot];
  const ab1 = send(alpha, beta, "ab one");
  const bg1 = send(beta, gamma, "bg one");
  const ab2 = send(beta, alpha, "ab two", ab1.id);
  const ag1 = send(gamma, alpha, "ag one");
  return { alpha, beta, gamma, ab1, ab2, bg1, ag1 };
}

test("the operator's conversation list has each pair once, newest first, with its last message and count", () => {
  const { ab2, bg1, ag1 } = conversations();
  const page = service.listConversations();
  expect(
    page.items
      .slice(0, 3)
      .map((c) => [
        c.bots.map((b) => b.name.replace(/-op\d+$/, "")).sort(),
        c.messageCount,
        c.lastMessage.id,
      ]),
  ).toEqual([
    [["alpha", "gamma"], 1, ag1.id],
    [["alpha", "beta"], 2, ab2.id],
    [["beta", "gamma"], 1, bg1.id],
  ]);
});

test("the conversation list pages to its end without repeating or skipping a pair", () => {
  const { ab2, bg1, ag1 } = conversations();
  const first = service.listConversations({ limit: 2 });
  expect(first.items.map((c) => c.lastMessage.id)).toEqual([ag1.id, ab2.id]);
  expect(first.nextCursor).not.toBeNull();
  const seen = first.items.map((c) => c.lastMessage.id);
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const next = service.listConversations({ limit: 2, cursor });
    seen.push(...next.items.map((c) => c.lastMessage.id));
    cursor = next.nextCursor;
  }
  expect(seen.slice(0, 3)).toEqual([ag1.id, ab2.id, bg1.id]);
  expect(new Set(seen).size).toBe(seen.length);
});

test("the operator reads one pair's messages oldest first, whichever bot is named first", () => {
  const { alpha, beta, gamma, bg1 } = conversations();
  for (const [a, b] of [
    [alpha, beta],
    [beta, alpha],
  ] as const) {
    expect(
      service.conversationMessages(a.id, b.id).items.map((m) => m.text),
    ).toEqual(["ab one", "ab two"]);
  }
  expect(
    service.conversationMessages(beta.id, gamma.id).items.map((m) => m.id),
  ).toEqual([bg1.id]);
});

test("a person, through the service, has no messages and finds none", () => {
  const person = db
    .insert(actor)
    .values({ kind: "human", displayName: "Riley Viewer" })
    .returning()
    .get();
  expect(service.listInbox(person, { all: true }).items).toEqual([]);
  const { alpha, ab1 } = conversations();
  expect(() => service.getThread(person, ab1.id)).toThrow(NotFoundError);
  expect(() =>
    service.sendMessage(person, { to: alpha.id, text: "hi" }),
  ).toThrow("only a bot may send a message");
});
