import { createRoute } from "@hono/zod-openapi";
import {
  labelCreateSchema,
  labelSchema,
  pageQuerySchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  idempotencyHeaders,
  jsonBody,
  jsonContent,
  notFoundError,
  projectParam,
  readErrors,
  writeErrors,
} from "./routes.js";
import { toLabel, toPage } from "./serialize.js";

const tags = ["labels"];

const createLabel = createRoute({
  method: "post",
  path: "/projects/{id}/labels",
  summary:
    "Create a label in a project (naming a new label on an issue creates it too)",
  tags,
  request: {
    params: projectParam,
    headers: idempotencyHeaders,
    body: jsonBody(labelCreateSchema),
  },
  responses: {
    201: jsonContent(labelSchema, "The created label"),
    ...forbiddenError("admin"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listLabels = createRoute({
  method: "get",
  path: "/projects/{id}/labels",
  summary: "List a project's labels, oldest first",
  tags,
  request: { params: projectParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(labelSchema), "A page of labels"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function labelRoutes(service: Service) {
  return createRouter()
    .openapi(createLabel, (c) =>
      c.json(
        toLabel(
          service.createLabel(
            c.var.actor,
            { ...c.req.valid("json"), projectId: c.req.valid("param").id },
            { idempotencyKey: c.req.valid("header")["idempotency-key"] },
          ),
        ),
        201,
      ),
    )
    .openapi(listLabels, (c) =>
      c.json(
        toPage(
          service.listLabels(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("query"),
          ),
          toLabel,
        ),
        200,
      ),
    );
}
