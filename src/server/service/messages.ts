import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client.js";
import { newId } from "../db/id.js";
import {
  actor,
  message,
  messagePair,
  webhookDelivery,
  webhookSubscription,
} from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import {
  ForbiddenError,
  NoReplyWantedError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  ValidationError,
} from "./errors.js";
import {
  type IdempotentRequest,
  replayOf,
  storeResult,
  validIdempotencyKey,
} from "./idempotency.js";
import {
  decode,
  encode,
  type Page,
  type PageQuery,
  pageLimit,
} from "./paging.js";
import type { Tx } from "./tx.js";

/** In UTF-8 bytes: 64 KiB. */
export const MESSAGE_TEXT_MAX_BYTES = 65_536;
/** How much of a message's text an inbox entry carries, in characters. */
export const MESSAGE_PREVIEW_CHARS = 200;
/** One sender's messages to one recipient per window: room for a busy exchange, too few for two bots stuck in a loop. */
export const MESSAGES_PER_PAIR = 30;
export const MESSAGE_WINDOW_MS = 10 * 60_000;
/** Most ids one mark_read takes. */
export const MARK_READ_MAX = 100;
export const MESSAGE_RECEIVED = "trail.message.received";

export type BotRef = { id: string; name: string };
export type Message = {
  id: string;
  seq: number;
  from: BotRef;
  to: BotRef;
  threadId: string;
  replyToId: string | null;
  text: string;
  expectsReply: boolean;
  createdAt: Date;
  readAt: Date | null;
};
export type SentMessage = {
  message: Message;
  thread: { id: string; messageCount: number };
};
export type MessageInput = {
  to?: string;
  text: string;
  replyTo?: string;
  expectsReply?: boolean;
};
export type InboxQuery = PageQuery & { all?: boolean };
export type MarkReadResult = {
  results: {
    id: string;
    result: "read" | "already_read" | "not_found";
    readAt: Date | null;
  }[];
  unreadMessages: number;
};
export type Conversation = {
  bots: [BotRef, BotRef];
  messageCount: number;
  lastMessage: Message;
};

/** Who calls: a bot by its own key, or a person, who has no messages. */
type Caller = { id: string; kind: string };

const sender = alias(actor, "sender");
const recipient = alias(actor, "recipient");

const selectMessages = (db: Db | Tx) =>
  db
    .select({
      id: message.id,
      seq: message.seq,
      fromId: sender.id,
      fromName: sender.displayName,
      toId: recipient.id,
      toName: recipient.displayName,
      threadId: message.threadId,
      replyToId: message.replyToId,
      text: message.text,
      expectsReply: message.expectsReply,
      createdAt: message.createdAt,
      readAt: message.readAt,
    })
    .from(message)
    .innerJoin(sender, eq(sender.id, message.senderId))
    .innerJoin(recipient, eq(recipient.id, message.recipientId));

type MessageRow = Awaited<
  ReturnType<ReturnType<typeof selectMessages>["all"]>
>[number];

const toMessage = ({
  fromId,
  fromName,
  toId,
  toName,
  ...row
}: MessageRow): Message => ({
  ...row,
  from: { id: fromId, name: fromName },
  to: { id: toId, name: toName },
});

/** Message `id` with its bots' names, whoever asks; undefined when there is none. */
export function findMessage(db: Db | Tx, id: string): Message | undefined {
  const row = selectMessages(db).where(eq(message.id, id)).get();
  return row && toMessage(row);
}

/** The pair `a`, `b` as `messagePair` orders it, lower id first. */
const ordered = (a: string, b: string): [string, string] =>
  a < b ? [a, b] : [b, a];
const [pairLow, pairHigh] = messagePair(message);

function validText(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MESSAGE_TEXT_MAX_BYTES) {
    throw new PayloadTooLargeError(
      `text is ${bytes} bytes, over the limit of ${MESSAGE_TEXT_MAX_BYTES} bytes (64 KiB of UTF-8): shorten it, or split it across several messages`,
    );
  }
  // SQLite's length() stops at a NUL, so the row's own check would refuse the text as empty
  if (text.includes("\u0000")) {
    throw new ValidationError(
      "text contains a NUL character (U+0000), which trail can't store: remove it and send again",
    );
  }
  if (text.trim() === "") {
    throw new ValidationError(
      "text must not be empty: send the message's markdown",
    );
  }
  return text;
}

/** A seq cursor bound to what it pages: `scope` names the list and its filters. */
function encodeSeqCursor(seq: number, scope: Record<string, unknown>): string {
  return encode({ seq, ...scope });
}

function decodeSeqCursor(
  cursor: string,
  scope: Record<string, unknown>,
  list: string,
): number {
  const parsed = decode(cursor) as Record<string, unknown> | undefined;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Number.isSafeInteger(parsed.seq)
  ) {
    throw new ValidationError(
      `cursor is invalid: pass a nextCursor exactly as the previous ${list} page returned it, or leave cursor out for the first page`,
    );
  }
  const { seq, ...issued } = parsed;
  if (JSON.stringify(issued) !== JSON.stringify(scope)) {
    throw new ValidationError(
      `cursor was issued for another list or filters (${JSON.stringify(issued)}) than this ${list} request (${JSON.stringify(scope)}): repeat the first request's filters with it, or leave cursor out to start over`,
    );
  }
  return seq as number;
}

const noMessage = (ref: string, field = "message") =>
  new NotFoundError(
    `no ${field} ${ref} among your messages: pass the id of a message you sent or received, from list_inbox (GET /api/v1/messages), message_bot or a trail.message.received webhook`,
  );

/**
 * Direct messages between bots. A message exists only for its two bots: to
 * anyone else every call answers as if it didn't, a 404, never a 403. Product
 * scope and key actions don't apply; any bot key messages as its own bot.
 */
export function createMessaging({
  db,
  bus,
  now,
}: {
  db: Db;
  bus: EventBus;
  now: () => number;
}) {
  /** The bot `ref` names by id, or by name ignoring the case of A-Z. */
  function resolveRecipient(tx: Tx, ref: string): BotRef {
    const found =
      tx.select().from(actor).where(eq(actor.id, ref)).get() ??
      tx
        .select()
        .from(actor)
        .where(
          and(
            eq(actor.kind, "bot"),
            sql`lower(${actor.displayName}) = lower(${ref.trim()})`,
          ),
        )
        .get();
    if (!found) {
      throw new NotFoundError(
        `no bot ${ref}: pass a bot's name (any case) or id as \`to\`. list_bots (GET /api/v1/bots) lists bots; or reply with replyTo to a message from list_inbox, which needs no \`to\``,
      );
    }
    if (found.kind !== "bot") {
      throw new ValidationError(
        `${ref} is a person, and people can't receive messages: only bots can. Message a bot instead; list_bots (GET /api/v1/bots) lists them`,
      );
    }
    return { id: found.id, name: found.displayName };
  }

  /** A message the caller sent or received, or a 404. */
  function ownMessage(tx: Db | Tx, caller: Caller, id: string, field?: string) {
    const row = selectMessages(tx)
      .where(
        and(
          eq(message.id, id),
          or(
            eq(message.senderId, caller.id),
            eq(message.recipientId, caller.id),
          ),
        ),
      )
      .get();
    if (!row) throw noMessage(id, field);
    return toMessage(row);
  }

  function unreadCount(tx: Db | Tx, botId: string): number {
    return (
      tx
        .select({ n: sql<number>`count(*)` })
        .from(message)
        .where(and(eq(message.recipientId, botId), isNull(message.readAt)))
        .get()?.n ?? 0
    );
  }

  /** Refuses a send past the pair's limit, saying how many seconds until one passes. */
  function refuseOverLimit(tx: Tx, from: string, to: BotRef, at: number) {
    const since = new Date(at - MESSAGE_WINDOW_MS);
    const inWindow = and(
      eq(message.senderId, from),
      eq(message.recipientId, to.id),
      gt(message.createdAt, since),
    );
    const count =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(message)
        .where(inWindow)
        .get()?.n ?? 0;
    if (count < MESSAGES_PER_PAIR) return;
    // the send whose leaving the window frees a slot
    const freeing = tx
      .select({ createdAt: message.createdAt })
      .from(message)
      .where(inWindow)
      .orderBy(asc(message.createdAt))
      .limit(1)
      .offset(count - MESSAGES_PER_PAIR)
      .get();
    const freesAt = (freeing?.createdAt.getTime() ?? at) + MESSAGE_WINDOW_MS;
    const wait = Math.max(1, Math.ceil((freesAt - at) / 1000));
    throw new RateLimitedError(
      `you sent ${to.name} ${count} messages in the last ${MESSAGE_WINDOW_MS / 60_000} minutes, the most allowed: try again in ${wait} seconds. If you are answering each other in a loop, stop and send nothing more`,
      wait,
    );
  }

  /** Queues the message for each of the recipient's inbox webhooks, in the transaction that writes it. */
  function enqueueInbox(
    tx: Tx,
    row: { id: string; seq: number; recipientId: string },
    at: number,
  ) {
    const subscribers = tx
      .select({ id: webhookSubscription.id })
      .from(webhookSubscription)
      .where(
        and(
          eq(webhookSubscription.actorId, row.recipientId),
          eq(webhookSubscription.kind, "inbox"),
        ),
      )
      .all();
    if (subscribers.length === 0) return;
    tx.insert(webhookDelivery)
      .values(
        subscribers.map((s) => ({
          subscriptionId: s.id,
          messageId: row.id,
          seq: row.seq,
          type: MESSAGE_RECEIVED,
          nextAttemptAt: new Date(at),
        })),
      )
      .run();
  }

  function threadSize(tx: Tx, threadId: string): number {
    return (
      tx
        .select({ n: sql<number>`count(*)` })
        .from(message)
        .where(eq(message.threadId, threadId))
        .get()?.n ?? 0
    );
  }

  return {
    /**
     * Sends `text` from the calling bot to `to`, or as a reply to `replyTo`
     * (whose other bot is then the recipient, and `to` may be left out).
     */
    sendMessage(
      caller: Caller,
      input: MessageInput,
      options: { idempotencyKey?: string } = {},
    ): SentMessage {
      if (caller.kind !== "bot") {
        throw new ForbiddenError("only a bot may send a message");
      }
      const text = validText(input.text);
      const key =
        options.idempotencyKey === undefined
          ? undefined
          : validIdempotencyKey(options.idempotencyKey);
      if (input.to === undefined && input.replyTo === undefined) {
        throw new ValidationError(
          "to is required: pass the bot's name or id, or pass replyTo with the id of the message you answer",
        );
      }
      const expectsReply = input.expectsReply ?? true;
      const { sent, committed } = db.transaction(
        (tx) => {
          const parent =
            input.replyTo === undefined
              ? undefined
              : ownMessage(tx, caller, input.replyTo, "replyTo message");
          const other =
            parent === undefined
              ? undefined
              : parent.from.id === caller.id
                ? parent.to
                : parent.from;
          const to =
            input.to === undefined
              ? (other as BotRef)
              : resolveRecipient(tx, input.to);
          if (to.id === caller.id) {
            throw new ValidationError(
              "you can't message yourself: to must name another bot",
            );
          }
          if (parent && other && other.id !== to.id) {
            throw new ValidationError(
              `replyTo message ${parent.id} is in your conversation with ${other.name}, not with ${to.name}: leave to out (or send to ${other.name}) to answer it, or leave replyTo out to start a new conversation with ${to.name}`,
            );
          }
          const idem: IdempotentRequest | undefined =
            key === undefined
              ? undefined
              : {
                  key,
                  scope: "message.send",
                  request: {
                    to: to.id,
                    text,
                    replyTo: parent?.id ?? null,
                    expectsReply,
                  },
                };
          if (idem) {
            const replay = replayOf<SentMessage>(tx, caller.id, idem);
            if (replay !== undefined) return { sent: replay, committed: null };
          }
          if (parent && parent.from.id !== caller.id && !parent.expectsReply) {
            throw new NoReplyWantedError(
              `${parent.from.name} sent message ${parent.id} with expectsReply false: the sender asked for no reply, so it can't be answered. If something really must be said, send a new message (leave replyTo out), not a reply`,
            );
          }
          const at = now();
          refuseOverLimit(tx, caller.id, to, at);
          const id = newId(at);
          const row = tx
            .insert(message)
            .values({
              id,
              senderId: caller.id,
              recipientId: to.id,
              threadId: parent?.threadId ?? id,
              replyToId: parent?.id ?? null,
              text,
              expectsReply,
              createdAt: new Date(at),
            })
            .returning()
            .get();
          enqueueInbox(tx, row, at);
          const result: SentMessage = {
            message: ownMessage(tx, caller, id),
            thread: {
              id: row.threadId,
              messageCount: threadSize(tx, row.threadId),
            },
          };
          if (idem) storeResult(tx, caller.id, idem, result);
          return { sent: result, committed: row };
        },
        { behavior: "immediate" },
      );
      if (committed) bus.publishMessage(committed);
      return sent;
    },

    /** The messages sent to the caller, newest first; unread ones only unless `all`. */
    listInbox(caller: Caller, query: InboxQuery = {}): Page<Message> {
      const limit = pageLimit(query.limit);
      const all = query.all === true;
      const scope = { list: "inbox", all };
      const filters: (SQL | undefined)[] = [
        eq(message.recipientId, caller.id),
        all ? undefined : isNull(message.readAt),
      ];
      if (query.cursor !== undefined) {
        filters.push(
          lt(message.seq, decodeSeqCursor(query.cursor, scope, "list_inbox")),
        );
      }
      const rows = selectMessages(db)
        .where(and(...filters))
        .orderBy(desc(message.seq))
        .limit(limit + 1)
        .all();
      const items = rows.slice(0, limit).map(toMessage);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last ? encodeSeqCursor(last.seq, scope) : null,
      };
    },

    /** Every message of the thread holding message `id`, oldest first; only its two bots see it. */
    getThread(
      caller: Caller,
      id: string,
      query: PageQuery = {},
    ): Page<Message> & { threadId: string; bots: [BotRef, BotRef] } {
      const found = ownMessage(db, caller, id);
      const root =
        found.id === found.threadId
          ? found
          : ownMessage(db, caller, found.threadId);
      const limit = pageLimit(query.limit);
      const scope = { list: "thread", threadId: found.threadId };
      const filters: (SQL | undefined)[] = [
        eq(message.threadId, found.threadId),
      ];
      if (query.cursor !== undefined) {
        filters.push(
          gt(message.seq, decodeSeqCursor(query.cursor, scope, "get_thread")),
        );
      }
      const rows = selectMessages(db)
        .where(and(...filters))
        .orderBy(asc(message.seq))
        .limit(limit + 1)
        .all();
      const items = rows.slice(0, limit).map(toMessage);
      const last = items.at(-1);
      return {
        threadId: found.threadId,
        bots: [root.from, root.to],
        items,
        nextCursor:
          rows.length > limit && last ? encodeSeqCursor(last.seq, scope) : null,
      };
    },

    /** Marks read the messages among `ids` sent to the caller; each id gets its own result. */
    markRead(caller: Caller, ids: string[]): MarkReadResult {
      const unique = [...new Set(ids)];
      if (unique.length === 0) {
        throw new ValidationError(
          "messageIds must name at least one message: pass ids from list_inbox",
        );
      }
      if (unique.length > MARK_READ_MAX) {
        throw new ValidationError(
          `messageIds names ${unique.length} messages, over the limit of ${MARK_READ_MAX}: mark them in batches of ${MARK_READ_MAX}`,
        );
      }
      return db.transaction(
        (tx) => {
          const mine = and(
            inArray(message.id, unique),
            eq(message.recipientId, caller.id),
          );
          const marked = new Set(
            tx
              .update(message)
              .set({ readAt: new Date(now()) })
              .where(and(mine, isNull(message.readAt)))
              .returning({ id: message.id })
              .all()
              .map((r) => r.id),
          );
          const readAt = new Map(
            tx
              .select({ id: message.id, readAt: message.readAt })
              .from(message)
              .where(mine)
              .all()
              .map((r) => [r.id, r.readAt]),
          );
          return {
            results: unique.map((id) => ({
              id,
              result: marked.has(id)
                ? ("read" as const)
                : readAt.has(id)
                  ? ("already_read" as const)
                  : ("not_found" as const),
              readAt: readAt.get(id) ?? null,
            })),
            unreadMessages: unreadCount(tx, caller.id),
          };
        },
        { behavior: "immediate" },
      );
    },

    /** How many messages to the caller are unread. */
    unreadMessages(caller: Caller): number {
      return unreadCount(db, caller.id);
    },

    /**
     * For the operator's read-only view, behind no key (the web layer checks
     * the viewer): each pair of bots that has exchanged messages, with its
     * newest message and count, newest conversation first.
     */
    listConversations(query: PageQuery = {}): Page<Conversation> {
      const limit = pageLimit(query.limit);
      const scope = { list: "conversations" };
      const lastSeq = sql<number>`max(${message.seq})`;
      const before =
        query.cursor === undefined
          ? undefined
          : sql`${lastSeq} < ${decodeSeqCursor(query.cursor, scope, "conversations")}`;
      const pairs = db
        .select({ lastSeq, count: sql<number>`count(*)` })
        .from(message)
        .groupBy(pairLow, pairHigh)
        .having(before)
        .orderBy(desc(lastSeq))
        .limit(limit + 1)
        .all();
      const page = pairs.slice(0, limit);
      const lasts = new Map(
        page.length === 0
          ? []
          : selectMessages(db)
              .where(
                inArray(
                  message.seq,
                  page.map((p) => p.lastSeq),
                ),
              )
              .all()
              .map((row) => [row.seq, toMessage(row)]),
      );
      const items = page.map((p) => {
        const last = lasts.get(p.lastSeq) as Message;
        const bots = [last.from, last.to].sort((a, b) =>
          a.id < b.id ? -1 : 1,
        ) as [BotRef, BotRef];
        return { bots, messageCount: p.count, lastMessage: last };
      });
      const tail = page.at(-1);
      return {
        items,
        nextCursor:
          pairs.length > limit && tail
            ? encodeSeqCursor(tail.lastSeq, scope)
            : null,
      };
    },

    /** For the operator's read-only view: every message between bots `a` and `b`, oldest first. */
    conversationMessages(
      a: string,
      b: string,
      query: PageQuery = {},
    ): Page<Message> {
      const limit = pageLimit(query.limit);
      const [low, high] = ordered(a, b);
      const scope = { list: "conversation", low, high };
      const filters: (SQL | undefined)[] = [
        sql`${pairLow} = ${low}`,
        sql`${pairHigh} = ${high}`,
      ];
      if (query.cursor !== undefined) {
        filters.push(
          gt(message.seq, decodeSeqCursor(query.cursor, scope, "conversation")),
        );
      }
      const rows = selectMessages(db)
        .where(and(...filters))
        .orderBy(asc(message.seq))
        .limit(limit + 1)
        .all();
      const items = rows.slice(0, limit).map(toMessage);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last ? encodeSeqCursor(last.seq, scope) : null,
      };
    },
  };
}
