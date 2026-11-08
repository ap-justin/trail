import { createRoute } from "@hono/zod-openapi";
import {
  activityEventSchema,
  activityListQuerySchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import { jsonContent, readErrors } from "./routes.js";
import { toActivityEvent, toPage } from "./serialize.js";

const listActivity = createRoute({
  method: "get",
  path: "/activity",
  summary: "List activity events, newest first, filtered by project or actor",
  tags: ["activity"],
  request: { query: activityListQuerySchema },
  responses: {
    200: jsonContent(pageSchema(activityEventSchema), "A page of events"),
    ...readErrors,
  },
});

export function activityRoutes(service: Service) {
  return createRouter().openapi(listActivity, (c) =>
    c.json(
      toPage(
        service.listActivity(c.var.actor, c.req.valid("query")),
        toActivityEvent,
      ),
      200,
    ),
  );
}
