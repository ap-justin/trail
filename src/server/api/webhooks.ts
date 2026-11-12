import { createRoute, z } from "@hono/zod-openapi";
import {
  pageSchema,
  webhookCreateSchema,
  webhookDeletedSchema,
  webhookSchema,
  webhookSecretUpdateSchema,
  webhookTestResultSchema,
  webhookUpdateSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { WEBHOOK_DELIVERY, WEBHOOK_SETUP } from "../webhooks/docs.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  jsonBody,
  jsonContent,
  notFoundError,
  readErrors,
  writeErrors,
} from "./routes.js";
import { toPage, toWebhook } from "./serialize.js";

const tags = ["webhooks"];
const own =
  "Acts on the calling bot's own webhooks only; a webhook of another bot, or one that follows a project outside the key's scope, is a 404.";

const webhookParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "The webhook's id, from the create or list response.",
    }),
});

const createWebhook = createRoute({
  method: "post",
  path: "/webhooks",
  summary: "Subscribe to projects' events with a signed webhook",
  description: `Needs the read action. ${WEBHOOK_SETUP} ${WEBHOOK_DELIVERY}`,
  tags,
  request: { body: jsonBody(webhookCreateSchema) },
  responses: {
    201: jsonContent(webhookSchema, "The webhook, without its secret"),
    ...forbiddenError("read"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listWebhooks = createRoute({
  method: "get",
  path: "/webhooks",
  summary: "List the calling bot's webhooks",
  description: `Needs the read action. ${own} Each carries paused, lastSuccessAt, lastError and lastErrorAt.`,
  tags,
  responses: {
    200: jsonContent(pageSchema(webhookSchema), "The bot's webhooks"),
    ...forbiddenError("read"),
    ...readErrors,
  },
});

const getWebhook = createRoute({
  method: "get",
  path: "/webhooks/{id}",
  summary: "Get a webhook",
  description: `Needs the read action. ${own}`,
  tags,
  request: { params: webhookParam },
  responses: {
    200: jsonContent(webhookSchema, "The webhook"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateWebhook = createRoute({
  method: "patch",
  path: "/webhooks/{id}",
  summary: "Change a webhook's URL or projects, and resume it",
  description: `Needs the read action. ${own} Fields left out stay as they are; projects replaces the whole list. Any update, one with no fields too, ends a pause. The secret changes through PUT /webhooks/{id}/secret.`,
  tags,
  request: { params: webhookParam, body: jsonBody(webhookUpdateSchema) },
  responses: {
    200: jsonContent(webhookSchema, "The updated webhook"),
    ...forbiddenError("read"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const rotateSecret = createRoute({
  method: "put",
  path: "/webhooks/{id}/secret",
  summary: "Replace a webhook's signing secret",
  description: `Needs the read action. ${own} The old secret stops signing at once; set the new one on your routine first or in the same script. Ends a pause. The secret is never returned. As on create, read it from a key in a script, not from chat.`,
  tags,
  request: { params: webhookParam, body: jsonBody(webhookSecretUpdateSchema) },
  responses: {
    200: jsonContent(webhookSchema, "The webhook, without its secret"),
    ...forbiddenError("read"),
    ...writeErrors,
    ...notFoundError,
  },
});

const deleteWebhook = createRoute({
  method: "delete",
  path: "/webhooks/{id}",
  summary: "Delete a webhook and its queued deliveries",
  description: `Needs the read action. ${own}`,
  tags,
  request: { params: webhookParam },
  responses: {
    200: jsonContent(webhookDeletedSchema, "The webhook is gone"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const pingWebhook = createRoute({
  method: "post",
  path: "/webhooks/{id}/ping",
  summary: "Send a signed trail.ping to a webhook",
  description: `Needs the read action. ${own} Sends one signed trail.ping now, outside the queue, and returns what the receiver answered, so you can check your routine before real events flow. A failed ping is a 200 with delivered false and the reason in error.`,
  tags,
  request: { params: webhookParam },
  responses: {
    200: jsonContent(webhookTestResultSchema, "What the receiver answered"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function webhookRoutes(service: Service) {
  return createRouter()
    .openapi(createWebhook, async (c) =>
      c.json(
        toWebhook(
          await service.createWebhook(c.var.actor, c.req.valid("json")),
        ),
        201,
      ),
    )
    .openapi(listWebhooks, (c) =>
      c.json(toPage(service.listWebhooks(c.var.actor), toWebhook), 200),
    )
    .openapi(getWebhook, (c) =>
      c.json(
        toWebhook(service.getWebhook(c.var.actor, c.req.valid("param").id)),
        200,
      ),
    )
    .openapi(updateWebhook, async (c) =>
      c.json(
        toWebhook(
          await service.updateWebhook(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
        200,
      ),
    )
    .openapi(rotateSecret, (c) =>
      c.json(
        toWebhook(
          service.rotateWebhookSecret(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("json").secret,
          ),
        ),
        200,
      ),
    )
    .openapi(deleteWebhook, (c) =>
      c.json(service.deleteWebhook(c.var.actor, c.req.valid("param").id), 200),
    )
    .openapi(pingWebhook, async (c) =>
      c.json(
        await service.testWebhook(c.var.actor, c.req.valid("param").id),
        200,
      ),
    );
}
