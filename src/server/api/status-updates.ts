import { createRoute } from "@hono/zod-openapi";
import {
  pageQuerySchema,
  pageSchema,
  statusUpdateCreateSchema,
  statusUpdateSchema,
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
import { toPage, toStatusUpdate } from "./serialize.js";

const tags = ["status updates"];

const createStatusUpdate = createRoute({
  method: "post",
  path: "/projects/{id}/status-updates",
  summary:
    "Post a project status update: a body and a health, as the calling bot",
  tags,
  request: {
    params: projectParam,
    headers: idempotencyHeaders,
    body: jsonBody(statusUpdateCreateSchema),
  },
  responses: {
    201: jsonContent(statusUpdateSchema, "The created status update"),
    ...forbiddenError("status_updates"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listStatusUpdates = createRoute({
  method: "get",
  path: "/projects/{id}/status-updates",
  summary: "List a project's status updates, newest first",
  tags,
  request: { params: projectParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(
      pageSchema(statusUpdateSchema),
      "A page of status updates",
    ),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function statusUpdateRoutes(service: Service) {
  return createRouter()
    .openapi(createStatusUpdate, (c) =>
      c.json(
        toStatusUpdate(
          service.createStatusUpdate(
            c.var.actor,
            { ...c.req.valid("json"), projectId: c.req.valid("param").id },
            { idempotencyKey: c.req.valid("header")["idempotency-key"] },
          ),
        ),
        201,
      ),
    )
    .openapi(listStatusUpdates, (c) =>
      c.json(
        toPage(
          service.listStatusUpdates(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("query"),
          ),
          toStatusUpdate,
        ),
        200,
      ),
    );
}
