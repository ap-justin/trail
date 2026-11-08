import { createRoute } from "@hono/zod-openapi";
import {
  commentCreateSchema,
  commentSchema,
  pageQuerySchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import { errorResponses, idParam, jsonBody, jsonContent } from "./routes.js";
import { toComment, toPage } from "./serialize.js";

const tags = ["comments"];

const addComment = createRoute({
  method: "post",
  path: "/issues/{id}/comments",
  summary: "Comment on an issue",
  tags,
  request: { params: idParam, body: jsonBody(commentCreateSchema) },
  responses: {
    201: jsonContent(commentSchema, "The created comment"),
    ...errorResponses,
  },
});

const listComments = createRoute({
  method: "get",
  path: "/issues/{id}/comments",
  summary: "List an issue's comments, oldest first",
  tags,
  request: { params: idParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(commentSchema), "A page of comments"),
    ...errorResponses,
  },
});

export function commentRoutes(service: Service) {
  return createRouter()
    .openapi(addComment, (c) =>
      c.json(
        toComment(
          service.addComment(c.var.actor, {
            issueId: c.req.valid("param").id,
            body: c.req.valid("json").body,
          }),
        ),
        201,
      ),
    )
    .openapi(listComments, (c) =>
      c.json(
        toPage(
          service.listComments(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("query"),
          ),
          toComment,
        ),
        200,
      ),
    );
}
