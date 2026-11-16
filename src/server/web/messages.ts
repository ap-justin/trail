import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import {
  errorSchema,
  pageQuerySchema,
  type WebActorView,
  webConversationPageSchema,
  webMessagePageSchema,
} from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import { previewOf } from "../api/serialize.js";
import type { Db } from "../db/client.js";
import { actor, message } from "../db/schema.js";
import { NotFoundError } from "../service/errors.js";
import type { Service } from "../service/index.js";
import { createWebRouter, ownerOnly } from "./env.js";
import { actorsById, selectWebActors, toWebActor } from "./visible.js";

const listConversations = createRoute({
  method: "get",
  path: "/messages",
  request: { query: pageQuerySchema },
  responses: {
    200: jsonContent(
      webConversationPageSchema,
      "Each pair of bots that has exchanged messages, newest conversation first",
    ),
  },
});

const pairParams = z.object({
  a: z.string().min(1).meta({ description: "One bot's id." }),
  b: z.string().min(1).meta({ description: "The other bot's id." }),
});

const readConversation = createRoute({
  method: "get",
  path: "/messages/{a}/{b}",
  request: { params: pairParams, query: pageQuerySchema },
  responses: {
    200: jsonContent(
      webMessagePageSchema,
      "The two bots and the messages between them, oldest first; reading marks none read",
    ),
    404: jsonContent(
      errorSchema,
      "a or b is not a bot's id, or both name the same bot",
    ),
  },
});

/** The messages between bots, read-only and for the person who runs trail alone. */
export function messageRoutes(db: Db, service: Service) {
  const messages = createWebRouter();
  messages.use("/messages", ownerOnly);
  messages.use("/messages/*", ownerOnly);
  return messages
    .openapi(listConversations, (c) => {
      const page = service.listConversations(c.req.valid("query"));
      const actorOf = actorsById(
        db,
        page.items.flatMap((p) => p.bots.map((b) => b.id)),
      );
      return c.json(
        {
          items: page.items.map(
            ({ bots, messageCount, lastMessage: last }) => ({
              bots: bots.map((b) => actorOf(b.id)) as [
                WebActorView,
                WebActorView,
              ],
              lastMessage: {
                id: last.id,
                senderId: last.from.id,
                ...previewOf(last.text),
                createdAt: last.createdAt.toISOString(),
                expectsReply: last.expectsReply,
              },
              count: messageCount,
              lastAt: last.createdAt.toISOString(),
            }),
          ),
          nextCursor: page.nextCursor,
        },
        200,
      );
    })
    .openapi(readConversation, (c) => {
      const { a, b } = c.req.valid("param");
      const actorOf = botPair(db, a, b);
      const page = service.conversationMessages(a, b, c.req.valid("query"));
      const quoted = quotesOf(
        db,
        page.items.flatMap((m) => (m.replyToId === null ? [] : [m.replyToId])),
      );
      return c.json(
        {
          bots: [a, b].sort().map(actorOf) as [WebActorView, WebActorView],
          items: page.items.map((m) => ({
            id: m.id,
            sender: actorOf(m.from.id),
            recipient: actorOf(m.to.id),
            threadId: m.threadId,
            replyTo: m.replyToId === null ? null : quoted(m.replyToId),
            text: m.text,
            expectsReply: m.expectsReply,
            createdAt: m.createdAt.toISOString(),
            readAt: m.readAt?.toISOString() ?? null,
          })),
          nextCursor: page.nextCursor,
        },
        200,
      );
    });
}

/** Bots `a` and `b`, by id; a 404 unless both are bots and they are two. */
function botPair(db: Db, a: string, b: string) {
  const bots = new Map(
    selectWebActors(db)
      .where(and(inArray(actor.id, [a, b]), eq(actor.kind, "bot")))
      .all()
      .map((row) => [row.id, toWebActor(row)]),
  );
  for (const id of [a, b]) {
    if (!bots.has(id)) throw new NotFoundError(`no bot with id ${id}`);
  }
  if (a === b) {
    throw new NotFoundError(
      "a bot has no conversation with itself: name two bots",
    );
  }
  return (id: string) => bots.get(id) as WebActorView;
}

/** The messages with these ids as reply quotes, by id; a reply's parent is never deleted, so every id is there. */
function quotesOf(db: Db, ids: string[]) {
  const rows =
    ids.length === 0
      ? []
      : db
          .select({
            id: message.id,
            senderId: message.senderId,
            text: message.text,
          })
          .from(message)
          .where(inArray(message.id, [...new Set(ids)]))
          .all();
  const nameOf = actorsById(
    db,
    rows.map((r) => r.senderId),
  );
  const byId = new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, senderName: nameOf(r.senderId).name, ...previewOf(r.text) },
    ]),
  );
  return (id: string) =>
    byId.get(id) as NonNullable<ReturnType<typeof byId.get>>;
}
