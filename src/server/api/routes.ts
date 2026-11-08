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

export const idParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: "id", in: "path" } }),
});
