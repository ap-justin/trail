import { createRoute } from "@hono/zod-openapi";
import {
  issueCreateSchema,
  issueListQuerySchema,
  issueSchema,
  issueUpdateSchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  idempotencyHeaders,
  issueParam,
  jsonBody,
  jsonContent,
  notFoundError,
  readErrors,
  writeErrors,
} from "./routes.js";
import { toIssue, toPage } from "./serialize.js";

const tags = ["issues"];

const createIssue = createRoute({
  method: "post",
  path: "/issues",
  summary: "Open an issue in a project",
  tags,
  request: {
    headers: idempotencyHeaders,
    body: jsonBody(issueCreateSchema),
  },
  responses: {
    201: jsonContent(issueSchema, "The created issue"),
    ...forbiddenError("issues"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listIssues = createRoute({
  method: "get",
  path: "/issues",
  summary: "List issues, newest first, filtered by project, status or assignee",
  tags,
  request: { query: issueListQuerySchema },
  responses: {
    200: jsonContent(pageSchema(issueSchema), "A page of issues"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/issues/{id}",
  summary: "Get an issue",
  tags,
  request: { params: issueParam },
  responses: {
    200: jsonContent(issueSchema, "The issue"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateIssue = createRoute({
  method: "patch",
  path: "/issues/{id}",
  summary:
    "Update an issue's title, description, status, assignee, estimate, priority, labels or links; addLabels, removeLabels, addLinks and removeLinks change part of the set in the same transaction",
  tags,
  request: { params: issueParam, body: jsonBody(issueUpdateSchema) },
  responses: {
    200: jsonContent(issueSchema, "The updated issue"),
    ...forbiddenError("issues"),
    ...writeErrors,
    ...notFoundError,
  },
});

export function issueRoutes(service: Service) {
  return createRouter()
    .openapi(createIssue, (c) =>
      c.json(
        toIssue(
          service.createIssue(c.var.actor, c.req.valid("json"), {
            idempotencyKey: c.req.valid("header")["idempotency-key"],
          }),
        ),
        201,
      ),
    )
    .openapi(listIssues, (c) =>
      c.json(
        toPage(service.listIssues(c.var.actor, c.req.valid("query")), toIssue),
        200,
      ),
    )
    .openapi(getIssue, (c) =>
      c.json(
        toIssue(service.getIssue(c.var.actor, c.req.valid("param").id)),
        200,
      ),
    )
    .openapi(updateIssue, (c) =>
      c.json(
        toIssue(
          service.updateIssue(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
        200,
      ),
    );
}
