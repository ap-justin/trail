import { createRoute } from "@hono/zod-openapi";
import {
  pageQuerySchema,
  pageSchema,
  projectCreateSchema,
  projectSchema,
  projectUpdateSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import { errorResponses, idParam, jsonBody, jsonContent } from "./routes.js";
import { toPage, toProject } from "./serialize.js";

const tags = ["projects"];

const createProject = createRoute({
  method: "post",
  path: "/projects",
  summary: "Create a project",
  tags,
  request: { body: jsonBody(projectCreateSchema) },
  responses: {
    201: jsonContent(projectSchema, "The created project"),
    ...errorResponses,
  },
});

const listProjects = createRoute({
  method: "get",
  path: "/projects",
  summary: "List projects, newest first",
  tags,
  request: { query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(projectSchema), "A page of projects"),
    ...errorResponses,
  },
});

const getProject = createRoute({
  method: "get",
  path: "/projects/{id}",
  summary: "Get a project",
  tags,
  request: { params: idParam },
  responses: {
    200: jsonContent(projectSchema, "The project"),
    ...errorResponses,
  },
});

const updateProject = createRoute({
  method: "patch",
  path: "/projects/{id}",
  summary: "Update a project's name or description",
  tags,
  request: { params: idParam, body: jsonBody(projectUpdateSchema) },
  responses: {
    200: jsonContent(projectSchema, "The updated project"),
    ...errorResponses,
  },
});

export function projectRoutes(service: Service) {
  return createRouter()
    .openapi(createProject, (c) =>
      c.json(
        toProject(service.createProject(c.var.actor, c.req.valid("json"))),
        201,
      ),
    )
    .openapi(listProjects, (c) =>
      c.json(
        toPage(
          service.listProjects(c.var.actor, c.req.valid("query")),
          toProject,
        ),
        200,
      ),
    )
    .openapi(getProject, (c) =>
      c.json(
        toProject(service.getProject(c.var.actor, c.req.valid("param").id)),
        200,
      ),
    )
    .openapi(updateProject, (c) =>
      c.json(
        toProject(
          service.updateProject(
            c.var.actor,
            c.req.valid("param").id,
            c.req.valid("json"),
          ),
        ),
        200,
      ),
    );
}
