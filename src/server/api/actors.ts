import { createRoute } from "@hono/zod-openapi";
import {
  botSchema,
  pageQuerySchema,
  pageSchema,
  whoamiSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import { forbiddenError, jsonContent, readErrors } from "./routes.js";
import { toBot, toPage, toWhoami } from "./serialize.js";

const tags = ["actors"];

const whoami = createRoute({
  method: "get",
  path: "/whoami",
  summary: "Get the actor the key belongs to",
  tags,
  responses: {
    200: jsonContent(whoamiSchema, "The calling bot and its key's scope"),
    401: readErrors[401],
  },
});

const listBots = createRoute({
  method: "get",
  path: "/bots",
  summary: "List bots, oldest first",
  tags,
  request: { query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(botSchema), "A page of bots"),
    ...forbiddenError("admin"),
    ...readErrors,
  },
});

export function actorRoutes(service: Service) {
  return createRouter()
    .openapi(whoami, (c) =>
      c.json(toWhoami(service.whoami(c.var.actor), c.var.actor.scope), 200),
    )
    .openapi(listBots, (c) =>
      c.json(
        toPage(service.listBots(c.var.actor, c.req.valid("query")), toBot),
        200,
      ),
    );
}
