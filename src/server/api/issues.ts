import { createRoute } from "@hono/zod-openapi";
import {
  issueCreateSchema,
  issueListQuerySchema,
  issueSchema,
  issueUpdateSchema,
  legacyIssueSchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { deprecations } from "./deprecations.js";
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
import { deprecated, toIssue, toPage } from "./serialize.js";

// The routes items had before todos: kept for one release, each answer carrying `deprecated`.
const tags = ["issues (deprecated)"];

const legacyPageSchema = pageSchema(issueSchema).extend({
  deprecated: legacyIssueSchema.shape.deprecated,
});

const createIssue = createRoute({
  method: "post",
  path: "/issues",
  summary: "Deprecated: create an item in a product (use POST /items)",
  description:
    "Deprecated alias of POST /items, removed after the next release. projectId takes the product's key. The item is a todo when the calling bot owns the product, else an issue in triage.",
  deprecated: true,
  tags,
  request: {
    headers: idempotencyHeaders,
    body: jsonBody(issueCreateSchema),
  },
  responses: {
    201: jsonContent(legacyIssueSchema, "The created item"),
    ...forbiddenError("issues"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listIssues = createRoute({
  method: "get",
  path: "/issues",
  summary: "Deprecated: list items (use GET /items)",
  description:
    "Deprecated alias of GET /items, removed after the next release; projectId takes the product's key.",
  deprecated: true,
  tags,
  request: { query: issueListQuerySchema },
  responses: {
    200: jsonContent(legacyPageSchema, "A page of items"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/issues/{id}",
  summary: "Deprecated: get an item (use GET /items/{key})",
  deprecated: true,
  tags,
  request: { params: issueParam },
  responses: {
    200: jsonContent(legacyIssueSchema, "The item"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateIssue = createRoute({
  method: "patch",
  path: "/issues/{id}",
  summary: "Deprecated: update an item (use PATCH /items/{key})",
  description:
    "Deprecated alias of PATCH /items/{key}, removed after the next release; assigneeId takes a bot's name or id.",
  deprecated: true,
  tags,
  request: { params: issueParam, body: jsonBody(issueUpdateSchema) },
  responses: {
    200: jsonContent(legacyIssueSchema, "The updated item"),
    ...forbiddenError("issues"),
    ...writeErrors,
    ...notFoundError,
  },
});

export function issueRoutes(service: Service) {
  return createRouter()
    .openapi(createIssue, (c) =>
      c.json(
        deprecated(
          toIssue(
            service.createIssue(c.var.actor, c.req.valid("json"), {
              idempotencyKey: c.req.valid("header")["idempotency-key"],
            }),
          ),
          deprecations.createIssue,
        ),
        201,
      ),
    )
    .openapi(listIssues, (c) => {
      const { projectId, assigneeId, ...query } = c.req.valid("query");
      return c.json(
        deprecated(
          toPage(
            service.listItems(c.var.actor, {
              ...query,
              product: projectId,
              assignee: assigneeId,
            }),
            toIssue,
          ),
          deprecations.listIssues,
        ),
        200,
      );
    })
    .openapi(getIssue, (c) =>
      c.json(
        deprecated(
          toIssue(service.getItem(c.var.actor, c.req.valid("param").id)),
          deprecations.getIssue,
        ),
        200,
      ),
    )
    .openapi(updateIssue, (c) =>
      c.json(
        deprecated(
          toIssue(
            service.updateItem(
              c.var.actor,
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
          ),
          deprecations.updateIssue,
        ),
        200,
      ),
    );
}
