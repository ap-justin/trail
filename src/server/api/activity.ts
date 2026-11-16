import { createRoute } from "@hono/zod-openapi";
import {
  activityListQuerySchema,
  activityPageSchema,
} from "../../shared/schemas.js";
import { ValidationError } from "../service/errors.js";
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
    "List activity events newest first (cursor), or resume oldest first (after), filtered by product, project or actor",
  description:
    "product and project filter by a product's key and a project's slug; projectId is the deprecated alias of product. A project's own events show for a key reaching any of its products.",
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
  return createRouter().openapi(listActivity, (c) => {
    const { projectId, product, ...query } = c.req.valid("query");
    if (projectId !== undefined && product !== undefined) {
      throw new ValidationError(
        "send product alone: projectId is its deprecated alias, and both together is ambiguous",
      );
    }
    return c.json(
      toPage(
        service.listActivity(c.var.actor, {
          ...query,
          product: product ?? projectId,
        }),
        toActivityEvent,
      ),
      200,
    );
  });
}
