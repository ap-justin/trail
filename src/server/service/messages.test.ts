import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";
import { NotFoundError } from "./errors.js";
import { createService } from "./index.js";

const { db, bus, webhooks, addBot } = setupTestApp();
const service = createService({ db, bus, webhooks });

const [alpha, beta, gamma] = ["alpha-op", "beta-op", "gamma-op"].map(
  (name) => addBot(name).actor,
) as [
  ReturnType<typeof addBot>["actor"],
  ReturnType<typeof addBot>["actor"],
  ReturnType<typeof addBot>["actor"],
];
const send = (
  from: typeof alpha,
  to: typeof alpha,
  text: string,
  replyTo?: string,
) => service.sendMessage(from, { to: to.id, text, replyTo }).message;

const ab1 = send(alpha, beta, "ab one");
const bg1 = send(beta, gamma, "bg one");
const ab2 = send(beta, alpha, "ab two", ab1.id);
const ag1 = send(gamma, alpha, "ag one");

test("the operator's conversation list has each pair once, newest first, with its last message and count", () => {
  const page = service.listConversations();
  expect(
    page.items.map((c) => [
      c.bots.map((b) => b.name).sort(),
      c.messageCount,
      c.lastMessage.id,
    ]),
  ).toEqual([
    [["alpha-op", "gamma-op"], 1, ag1.id],
    [["alpha-op", "beta-op"], 2, ab2.id],
    [["beta-op", "gamma-op"], 1, bg1.id],
  ]);
  const first = service.listConversations({ limit: 2 });
  expect(first.items).toHaveLength(2);
  const rest = service.listConversations({
    limit: 2,
    cursor: first.nextCursor ?? "",
  });
  expect(rest.items.map((c) => c.lastMessage.id)).toEqual([bg1.id]);
  expect(rest.nextCursor).toBeNull();
});

test("the operator reads one pair's messages oldest first, whichever bot is named first", () => {
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
  expect(() => service.getThread(person, ab1.id)).toThrow(NotFoundError);
  expect(() =>
    service.sendMessage(person, { to: alpha.id, text: "hi" }),
  ).toThrow("only a bot may send a message");
});
