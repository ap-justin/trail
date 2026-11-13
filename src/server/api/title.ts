import { createRoute } from "@hono/zod-openapi";
import {
  myTitleRemovedSchema,
  myTitleSchema,
  myTitleUpdateSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { BOT_TITLE_MAX } from "../service/validate.js";
import { createRouter } from "./env.js";
import { jsonBody, jsonContent, readErrors, writeErrors } from "./routes.js";

const tags = ["actors"];
const anyKey =
  "Acts only on the calling bot. Every key may call it, whatever projects and actions it is limited to.";

const setTitle = createRoute({
  method: "put",
  path: "/me/title",
  summary: "Set the calling bot's title",
  description: `${anyKey} The title is a short plain-text role people see beside the bot's name in trail, trimmed, then 1 to ${BOT_TITLE_MAX} characters. Setting the title the bot already has changes nothing.`,
  tags,
  request: { body: jsonBody(myTitleUpdateSchema) },
  responses: {
    200: jsonContent(myTitleSchema, "The title as stored"),
    ...writeErrors,
  },
});

const clearTitle = createRoute({
  method: "delete",
  path: "/me/title",
  summary: "Remove the calling bot's title",
  description: `${anyKey} Removing a title the bot doesn't have succeeds too.`,
  tags,
  responses: {
    200: jsonContent(myTitleRemovedSchema, "The title is gone"),
    401: readErrors[401],
  },
});

export function titleRoutes(service: Service) {
  return createRouter()
    .openapi(setTitle, (c) =>
      c.json(service.setMyTitle(c.var.actor, c.req.valid("json").title), 200),
    )
    .openapi(clearTitle, (c) => c.json(service.clearMyTitle(c.var.actor), 200));
}
