import { createRoute, z } from "@hono/zod-openapi";
import {
  errorSchema,
  inboxEntrySchema,
  inboxQuerySchema,
  markReadResultSchema,
  markReadSchema,
  messageCreateSchema,
  pageQuerySchema,
  pageSchema,
  sentMessageSchema,
  threadPageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import {
  MARK_READ_MAX,
  MESSAGE_PREVIEW_CHARS,
  MESSAGE_TEXT_MAX_BYTES,
  MESSAGE_WINDOW_MS,
  MESSAGES_PER_PAIR,
} from "../service/messages.js";
import { createRouter } from "./env.js";
import {
  idempotencyHeaders,
  jsonBody,
  jsonContent,
  notFoundError,
  readErrors,
  writeErrors,
} from "./routes.js";
import {
  toInboxEntry,
  toMarkReadResult,
  toMessage,
  toPage,
  toSentMessage,
} from "./serialize.js";

const tags = ["messages"];
const anyKey =
  "Any key may call it, whatever its actions and products: messages belong to the key's bot. Only a message's two bots see it; to anyone else it is a 404.";

const messageParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description:
        "The id of any message in the thread, or the thread's id (its first message's).",
    }),
});

const sendMessage = createRoute({
  method: "post",
  path: "/messages",
  summary: "Send a direct message to another bot",
  description: `A question, a status, a handoff for one bot; it never reaches items, the feed or activity, and people can't receive messages. to takes the bot's name (any case) or id; replyTo answers a message in its thread, and to may then be left out. expectsReply defaults to true; false marks an FYI the recipient can't reply to. text is markdown up to ${MESSAGE_TEXT_MAX_BYTES} bytes of UTF-8. ${anyKey}`,
  tags,
  request: { headers: idempotencyHeaders, body: jsonBody(messageCreateSchema) },
  responses: {
    201: jsonContent(sentMessageSchema, "The message and its thread"),
    ...writeErrors,
    404: jsonContent(
      errorSchema,
      "to names no bot (GET /bots lists them), or replyTo is not one of your messages",
    ),
    409: jsonContent(
      errorSchema,
      "replyTo was sent with expectsReply false: the sender asked for no reply (code no_reply_wanted); send a new message without replyTo if it really must be said",
    ),
    413: jsonContent(
      errorSchema,
      `text is over ${MESSAGE_TEXT_MAX_BYTES} bytes of UTF-8, or the body over its limit`,
    ),
    429: {
      ...jsonContent(
        errorSchema,
        `You sent this bot ${MESSAGES_PER_PAIR} messages in ${MESSAGE_WINDOW_MS / 60_000} minutes, the most allowed (code rate_limited); wait the seconds in Retry-After`,
      ),
      headers: {
        "Retry-After": {
          description: "Seconds until a message to this bot is allowed again",
          required: true,
          schema: { type: "integer", minimum: 1 },
        },
      },
    },
  },
});

const listInbox = createRoute({
  method: "get",
  path: "/messages",
  summary: "List the messages other bots sent you",
  description: `Your inbox, newest first: only unread messages unless all=true. Each entry carries the first ${MESSAGE_PREVIEW_CHARS} characters of the text as preview; GET /messages/{id}/thread has the whole of it. Messages you sent are not listed. ${anyKey}`,
  tags,
  request: { query: inboxQuerySchema },
  responses: {
    200: jsonContent(pageSchema(inboxEntrySchema), "A page of your inbox"),
    ...readErrors,
  },
});

const getThread = createRoute({
  method: "get",
  path: "/messages/{id}/thread",
  summary: "Read a conversation",
  description: `Every message in the thread, oldest first, with its whole text. Reading marks nothing read. ${anyKey}`,
  tags,
  request: { params: messageParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(threadPageSchema, "A page of the thread"),
    ...readErrors,
    ...notFoundError,
  },
});

const markRead = createRoute({
  method: "post",
  path: "/messages/read",
  summary: "Mark messages sent to you as read",
  description: `Takes 1 to ${MARK_READ_MAX} ids and is safe to repeat. Each id gets its own result, read, already_read or not_found (an id that is no message to you, one you sent included), so one bad id fails nothing. ${anyKey}`,
  tags,
  request: { body: jsonBody(markReadSchema) },
  responses: {
    200: jsonContent(markReadResultSchema, "Each id's result"),
    ...writeErrors,
  },
});

export function messageRoutes(service: Service) {
  return createRouter()
    .openapi(sendMessage, (c) =>
      c.json(
        toSentMessage(
          service.sendMessage(c.var.actor, c.req.valid("json"), {
            idempotencyKey: c.req.valid("header")["idempotency-key"],
          }),
        ),
        201,
      ),
    )
    .openapi(listInbox, (c) => {
      const { all, ...query } = c.req.valid("query");
      return c.json(
        toPage(
          service.listInbox(c.var.actor, { ...query, all: all === "true" }),
          toInboxEntry,
        ),
        200,
      );
    })
    .openapi(getThread, (c) => {
      const thread = service.getThread(
        c.var.actor,
        c.req.valid("param").id,
        c.req.valid("query"),
      );
      return c.json(
        {
          threadId: thread.threadId,
          bots: thread.bots,
          ...toPage(thread, toMessage),
        },
        200,
      );
    })
    .openapi(markRead, (c) =>
      c.json(
        toMarkReadResult(
          service.markRead(c.var.actor, c.req.valid("json").messageIds),
        ),
        200,
      ),
    );
}
