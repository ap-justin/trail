import { createRoute } from "@hono/zod-openapi";
import {
  errorSchema,
  importResultSchema,
  importSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  IMPORT_MAX_BODY_BYTES,
  jsonBody,
  jsonContent,
  limitBody,
  writeErrors,
} from "./routes.js";
import { toImportResult } from "./serialize.js";

const importProject = createRoute({
  method: "post",
  path: "/import",
  summary:
    "Import a project from another tracker with its issues, comments, labels, links and status updates, matched by externalRef: a re-run updates what changed and never duplicates",
  tags: ["import"],
  middleware: [limitBody(IMPORT_MAX_BODY_BYTES)] as const,
  request: { body: jsonBody(importSchema) },
  responses: {
    200: jsonContent(
      importResultSchema,
      "The project, and per kind how many rows were created, updated and left unchanged",
    ),
    ...writeErrors,
    413: jsonContent(
      errorSchema,
      `The body is over ${IMPORT_MAX_BODY_BYTES} bytes`,
    ),
    ...forbiddenError,
    ...conflictError,
  },
});

export function importRoutes(service: Service) {
  return createRouter().openapi(importProject, (c) =>
    c.json(
      toImportResult(service.importProject(c.var.actor, c.req.valid("json"))),
      200,
    ),
  );
}
