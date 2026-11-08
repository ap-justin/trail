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
import { errorResponses, idParam, jsonBody, jsonContent } from "./routes.js";
import { toIssue, toPage } from "./serialize.js";

const tags = ["issues"];

const createIssue = createRoute({
  method: "post",
  path: "/issues",
  summary: "Open an issue in a project",
  tags,
  request: { body: jsonBody(issueCreateSchema) },
  responses: {
    201: jsonContent(issueSchema, "The created issue"),
    ...errorResponses,
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
    ...errorResponses,
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/issues/{id}",
  summary: "Get an issue",
  tags,
  request: { params: idParam },
  responses: {
    200: jsonContent(issueSchema, "The issue"),
    ...errorResponses,
  },
});

const updateIssue = createRoute({
  method: "patch",
  path: "/issues/{id}",
  summary: "Update an issue's title, description, status or assignee",
  tags,
  request: { params: idParam, body: jsonBody(issueUpdateSchema) },
  responses: {
    200: jsonContent(issueSchema, "The updated issue"),
    ...errorResponses,
  },
});

export function issueRoutes(service: Service) {
  return createRouter()
    .openapi(createIssue, (c) =>
      c.json(
        toIssue(service.createIssue(c.var.actor, c.req.valid("json"))),
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
