import { createRoute, z } from "@hono/zod-openapi";
import {
  commentCreateSchema,
  commentSchema,
  createdCommentSchema,
  pageQuerySchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { deprecations } from "./deprecations.js";
import { createRouter } from "./env.js";
import { COMMENT_HOLDS } from "./items.js";
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
import {
  deprecated,
  toComment,
  toCreatedComment,
  toPage,
} from "./serialize.js";

// The comment routes under /issues: kept for one release, each answer carrying `deprecated`.
const tags = ["issues (deprecated)"];
const legacyCommentSchema = createdCommentSchema
  .extend({ deprecated: z.string() })
  .openapi("LegacyComment");
const legacyCommentPageSchema = pageSchema(commentSchema).extend({
  deprecated: z.string(),
});

const addComment = createRoute({
  method: "post",
  path: "/issues/{id}/comments",
  summary: "Deprecated: comment on an item (use POST /items/{key}/comments)",
  description: COMMENT_HOLDS,
  deprecated: true,
  tags,
  request: {
    params: issueParam,
    headers: idempotencyHeaders,
    body: jsonBody(commentCreateSchema),
  },
  responses: {
    201: jsonContent(legacyCommentSchema, "The created comment"),
    ...forbiddenError("comments"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listComments = createRoute({
  method: "get",
  path: "/issues/{id}/comments",
  summary:
    "Deprecated: list an item's comments (use GET /items/{key}/comments)",
  deprecated: true,
  tags,
  request: { params: issueParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(legacyCommentPageSchema, "A page of comments"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function commentRoutes(service: Service) {
  return createRouter()
    .openapi(addComment, (c) =>
      c.json(
        deprecated(
          toCreatedComment(
            service.addComment(
              c.var.actor,
              { ...c.req.valid("json"), issueId: c.req.valid("param").id },
              { idempotencyKey: c.req.valid("header")["idempotency-key"] },
            ),
            "rest",
          ),
          deprecations.comments,
        ),
        201,
      ),
    )
    .openapi(listComments, (c) =>
      c.json(
        deprecated(
          toPage(
            service.listComments(
              c.var.actor,
              c.req.valid("param").id,
              c.req.valid("query"),
            ),
            toComment,
          ),
          deprecations.comments,
        ),
        200,
      ),
    );
}
