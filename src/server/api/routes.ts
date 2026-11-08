import { z } from "@hono/zod-openapi";
import { errorSchema } from "../../shared/schemas.js";

export const jsonContent = <T extends z.ZodType>(
  schema: T,
  description: string,
) => ({ content: { "application/json": { schema } }, description });

export const MAX_BODY_BYTES = 1024 * 1024;

/** The error responses every authenticated read documents beside its own. */
export const readErrors = {
  401: jsonContent(
    errorSchema,
    "Missing, malformed, unknown or revoked bot key",
  ),
  422: jsonContent(errorSchema, "The request failed validation"),
};

/** Spread only into operations whose service call can throw `NotFoundError`. */
export const notFoundError = {
  404: jsonContent(errorSchema, "No such resource"),
};

/** Spread only into operations whose service call runs `requireBot`. */
export const forbiddenError = {
  403: jsonContent(errorSchema, "Only a bot may make this write"),
};

/** Spread only into operations whose service call can throw `ConflictError`. */
export const conflictError = {
  409: jsonContent(
    errorSchema,
    "A unique value (a key, name or externalRef) is already in use",
  ),
};

/** The request schema of every create: a repeat with the same key returns the first result. */
export const idempotencyHeaders = z.object({
  "idempotency-key": z.string().min(1).max(255).optional().openapi({
    description:
      "Makes the create safe to retry: a repeat with the same key and request returns the first response and writes nothing. Reusing a key for a different request is a 422 (code idempotency_key_reused).",
    example: "3f6c1e0a-run-42-issue-7",
  }),
});

/** The error responses every route with a `jsonBody` documents beside its own. */
export const writeErrors = {
  400: jsonContent(errorSchema, "The body is missing or not valid JSON"),
  ...readErrors,
  413: jsonContent(errorSchema, `The body is over ${MAX_BODY_BYTES} bytes`),
  415: jsonContent(errorSchema, "The body is not sent as application/json"),
};

/** A required JSON body: a missing or malformed one is a 400, one sent as another media type a 415. */
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
  required: true,
});

export const issueParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "The issue's id or its key, like TRL-12.",
      example: "TRL-12",
    }),
});

export const projectParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "The project's id or its key, like TRL.",
      example: "TRL",
    }),
});
