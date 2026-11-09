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
    "Import a project from another tracker with its issues, comments, labels, links and status updates, matched by externalRef",
  description:
    "Rows are matched by externalRef (Linear's id, a UUID), so a re-run never duplicates. Send each issue's sourceKey (Linear's identifier, like JUS-187): it is stored, so GET /issues/JUS-187 finds the issue, and a new issue keeps that number when its prefix is the project's key; if another issue holds the number, the new one gets the project's next number and is listed in the result's renumbered. Descriptions and comment bodies may be up to 1 MiB and an issue may have up to 200 links. A 422 lists every invalid row with its sourceKey or externalRef, and nothing is imported. A re-run sets each matched row's fields, labels and links to the payload's values, replacing changes made in trail since the last import, and never deletes rows.",
  tags: ["import"],
  middleware: [limitBody(IMPORT_MAX_BODY_BYTES)] as const,
  request: { body: jsonBody(importSchema) },
  responses: {
    200: jsonContent(
      importResultSchema,
      "The project, per kind how many rows were created, updated and left unchanged, and the issues that were renumbered",
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
