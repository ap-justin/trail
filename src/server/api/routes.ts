import { z } from "@hono/zod-openapi";
import { errorSchema } from "../../shared/schemas.js";

export const jsonContent = <T extends z.ZodType>(
  schema: T,
  description: string,
) => ({ content: { "application/json": { schema } }, description });

/** The error responses every authenticated route documents beside its own. */
export const errorResponses = {
  401: jsonContent(
    errorSchema,
    "Missing, malformed, unknown or revoked bot key",
  ),
  403: jsonContent(errorSchema, "The actor may not make this write"),
  404: jsonContent(errorSchema, "No such resource"),
  422: jsonContent(errorSchema, "The request failed validation"),
};

/** A required JSON body: a missing one is a 422, one sent as another media type a 415. */
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
