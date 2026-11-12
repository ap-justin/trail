import { createRoute } from "@hono/zod-openapi";
import {
  activityListQuerySchema,
  activityPageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import {
  forbiddenError,
  jsonContent,
  notFoundError,
  readErrors,
} from "./routes.js";
import { toActivityEvent, toPage } from "./serialize.js";

const listActivity = createRoute({
  method: "get",
  path: "/activity",
  summary:
    "List activity events newest first (cursor), or resume oldest first (after), filtered by project or actor",
  tags: ["activity"],
  request: { query: activityListQuerySchema },
  responses: {
    200: jsonContent(activityPageSchema, "A page of events"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
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
