import { createRoute } from "@hono/zod-openapi";
import {
  actorSchema,
  botSchema,
  pageQuerySchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import { jsonContent, readErrors } from "./routes.js";
import { toActor, toBot, toPage } from "./serialize.js";

const tags = ["actors"];

const whoami = createRoute({
  method: "get",
  path: "/whoami",
  summary: "Get the actor the key belongs to",
  tags,
  responses: {
    200: jsonContent(actorSchema, "The calling actor"),
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
    ...readErrors,
  },
});

export function actorRoutes(service: Service) {
  return createRouter()
    .openapi(whoami, (c) => c.json(toActor(service.whoami(c.var.actor)), 200))
    .openapi(listBots, (c) =>
      c.json(
        toPage(service.listBots(c.var.actor, c.req.valid("query")), toBot),
        200,
      ),
    );
}
