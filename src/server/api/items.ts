import { createRoute } from "@hono/zod-openapi";
import {
  commentCreateSchema,
  commentSchema,
  issueSchema,
  itemCreateSchema,
  itemListQuerySchema,
  itemUpdateSchema,
  pageQuerySchema,
  pageSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  idempotencyHeaders,
  itemParam,
  jsonBody,
  jsonContent,
  notFoundError,
  readErrors,
  writeErrors,
} from "./routes.js";
import { toComment, toIssue, toPage } from "./serialize.js";

const tags = ["items"];

export const TODO_OR_ISSUE =
  "A todo is planned work of a product's own bot: open from the start and always assigned (to the product's owner unless you name someone). An issue is a report to a product's bot, from a person or another product's bot: it starts in triage until that bot accepts it (status open) or cancels it.";

const createItem = createRoute({
  method: "post",
  path: "/items",
  summary: "Add a todo or file an issue",
  description: `Needs the issues action on a key that reaches the product. ${TODO_OR_ISSUE} A todo without product goes to the one product you own; with none or several, the 422 lists the products to pick from. It gets the product's next number, so its key reads like TRL-12.`,
  tags,
  request: {
    headers: idempotencyHeaders,
    body: jsonBody(itemCreateSchema),
  },
  responses: {
    201: jsonContent(issueSchema, "The created item"),
    ...forbiddenError("issues"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listItems = createRoute({
  method: "get",
  path: "/items",
  summary:
    "List items newest first, filtered by product, project, type, status or assignee",
  tags,
  request: { query: itemListQuerySchema },
  responses: {
    200: jsonContent(pageSchema(issueSchema), "A page of items"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const getItem = createRoute({
  method: "get",
  path: "/items/{key}",
  summary: "Get an item",
  tags,
  request: { params: itemParam },
  responses: {
    200: jsonContent(issueSchema, "The item"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateItem = createRoute({
  method: "patch",
  path: "/items/{key}",
  summary:
    "Change an item's type, status, assignee, title, description, estimate, priority, labels or links",
  description: `Needs the issues action. ${TODO_OR_ISSUE} Accept an issue from triage with status open, or drop it with canceled. type todo on an item in triage opens it; a todo never goes back to triage and never loses its assignee. Fields left out stay as they are; addLabels, removeLabels, addLinks and removeLinks change part of a set in the same transaction. Moving to done or canceled stamps completedAt; reopening clears it.`,
  tags,
  request: { params: itemParam, body: jsonBody(itemUpdateSchema) },
  responses: {
    200: jsonContent(issueSchema, "The updated item"),
    ...forbiddenError("issues"),
    ...writeErrors,
    ...notFoundError,
  },
});

const addComment = createRoute({
  method: "post",
  path: "/items/{key}/comments",
  summary: "Comment on an item, todo or issue",
  tags,
  request: {
    params: itemParam,
    headers: idempotencyHeaders,
    body: jsonBody(commentCreateSchema),
  },
  responses: {
    201: jsonContent(commentSchema, "The created comment"),
    ...forbiddenError("comments"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listComments = createRoute({
  method: "get",
  path: "/items/{key}/comments",
  summary: "List an item's comments, oldest first",
  tags,
  request: { params: itemParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(commentSchema), "A page of comments"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function itemRoutes(service: Service) {
  return createRouter()
    .openapi(createItem, (c) => {
      const { type, ...input } = c.req.valid("json");
      const options = {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      };
      const created =
        type === "todo"
          ? service.addTodo(c.var.actor, input, options)
          : service.fileIssue(c.var.actor, input, options);
      return c.json(toIssue(created), 201);
    })
    .openapi(listItems, (c) =>
      c.json(
        toPage(service.listItems(c.var.actor, c.req.valid("query")), toIssue),
        200,
      ),
    )
    .openapi(getItem, (c) =>
      c.json(
        toIssue(service.getItem(c.var.actor, c.req.valid("param").key)),
        200,
      ),
    )
    .openapi(updateItem, (c) => {
      const { assignee, ...patch } = c.req.valid("json");
      return c.json(
        toIssue(
          service.updateItem(c.var.actor, c.req.valid("param").key, {
            ...patch,
            assigneeId: assignee,
          }),
        ),
        200,
      );
    })
    .openapi(addComment, (c) =>
      c.json(
        toComment(
          service.addComment(
            c.var.actor,
            { ...c.req.valid("json"), issueId: c.req.valid("param").key },
            { idempotencyKey: c.req.valid("header")["idempotency-key"] },
          ),
        ),
        201,
      ),
    )
    .openapi(listComments, (c) =>
      c.json(
        toPage(
          service.listComments(
            c.var.actor,
            c.req.valid("param").key,
            c.req.valid("query"),
          ),
          toComment,
        ),
        200,
      ),
    );
}
