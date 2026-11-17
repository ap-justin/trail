import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { errorSchema } from "../../shared/schemas.js";
import type { ApiKeyAction } from "../db/schema.js";
import { errorResponse } from "./errors.js";

export const jsonContent = <T extends z.ZodType>(
  schema: T,
  description: string,
) => ({ content: { "application/json": { schema } }, description });

export const MAX_BODY_BYTES = 1024 * 1024;
/** The body limit of an import, which carries a whole project: POST /import and /mcp. */
export const IMPORT_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Refuses a body over `maxSize` bytes with a 413 in the shared error shape. */
export const limitBody = (
  maxSize: number,
  message = `request body exceeds ${maxSize} bytes`,
) =>
  bodyLimit({
    maxSize,
    onError: (c) => errorResponse(c, 413, "payload_too_large", message),
  });

const jsonType = /^\s*application\/json\s*(;|$)/i;

/**
 * Refuses a write whose body isn't declared application/json with a 415: a
 * form or text body would otherwise read as an empty one and a write could
 * succeed having changed nothing. A write with no body (a ping, a delete)
 * passes whatever its Content-Type says, since nothing is read. The photo upload takes raw bytes and is exempt.
 * A request no route takes passes on to the 404, so an unknown path or method isn't
 * answered as a body problem.
 */
export const jsonBodiesOnly = createMiddleware(async (c, next) => {
  const method = c.req.method;
  if (
    (method !== "POST" && method !== "PUT" && method !== "PATCH") ||
    (method === "PUT" && /\/me\/photo\/?$/.test(c.req.path)) ||
    // middleware (this one included) is registered under ALL; a route under its own method
    !matchedRoutes(c).some((route) => route.method === method)
  ) {
    return next();
  }
  const type = c.req.header("content-type");
  const hasBody =
    c.req.header("transfer-encoding") !== undefined ||
    !["", "0"].includes(c.req.header("content-length") ?? "");
  if (hasBody && (type === undefined || !jsonType.test(type))) {
    return errorResponse(
      c,
      415,
      "unsupported_media_type",
      `send the body as JSON with the header Content-Type: application/json (curl -H 'Content-Type: application/json' -d '{...}'); this request's body is ${type === undefined ? "sent with no Content-Type" : `${type.split(";")[0]?.trim() || "an empty type"}`}`,
    );
  }
  return next();
});

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

/**
 * The 403 of an operation a key's actions gate: spread into every operation but
 * whoami. `scope` adds the refusal of a key limited to products, for the
 * operations that make one, worded by `scope` when it is a string; `owner`
 * the refusal of a write only the product's owner bot makes. (The service's
 * bot-only 403 can't reach /api/v1, whose every caller is a bot.)
 */
export const forbiddenError = (
  action: ApiKeyAction,
  { scope = false, owner }: { scope?: boolean | string; owner?: string } = {},
) => ({
  403: jsonContent(
    errorSchema,
    `The key lacks the ${action} action (code forbidden_action)${scope === false ? "" : `, or ${scope === true ? "reaches only some products" : scope} (code forbidden_scope)`}${owner === undefined ? "" : `, or ${owner} (code forbidden)`}`,
  ),
});

/** The forbidden_scope 403 of a change to an item the key reads only through a project drawing from its products. */
export const VIA_PROJECT =
  "the key reaches the item only through a project drawing from one of its products (access via_project), which lets it read the item and comment on it and nothing else; the message names the project, the grants that would allow the change and whom to ask";

/** The forbidden_scope 403 of adding items to a project. */
export const PROJECT_ADD_SCOPE = `${VIA_PROJECT}; or the project doesn't draw from an item's product yet and the key doesn't list that product`;

/** The forbidden_scope 403 of taking items out of a project. */
export const PROJECT_REMOVE_SCOPE = `${VIA_PROJECT}; or the key reads the project only through its products and doesn't list the item's product`;

/** The forbidden_scope 403 of a filing on a product the key reads only through such a project. */
export const VIA_PROJECT_FILING =
  "the key reads the product only through a project drawing from one of its products, so it files nothing on it; the message names the product to file on instead and the grants that would allow it";

/** The 403 a write only a product's owner makes adds to `forbiddenError`. */
export const OWNER_ONLY =
  "the product has an owner bot and the call is that bot's alone: adding a todo, moving an issue out of triage, canceling an item another bot filed, reopening a canceled issue another bot filed, or changing an item's type; the message names the owner and what to do instead";

/** Who creates a product's labels, as the create-label route and tool describe it. */
export const LABEL_CREATORS =
  "Only a product's owner creates its labels. Anyone else gets a 403 (forbidden) naming the owner and the label: ask the owner to create it, or file or update the item without it, and names the product lacks come back in skippedLabels. On a product with no owner, any bot creates them.";

/** The 403 the create-label routes add to `forbiddenError`. */
export const OWNER_CREATES_LABELS =
  "another bot owns the product: only its owner creates its labels";

/** Spread only into operations whose service call can throw `ConflictError`. */
export const conflictError = {
  409: jsonContent(
    errorSchema,
    "A unique value (a key, name, number or externalRef) is already in use",
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

export const itemParam = z.object({
  key: z
    .string()
    .min(1)
    .openapi({
      param: { name: "key", in: "path" },
      description:
        "The item's key (like TRL-12), its id, or its source key (the key it had in the system it was imported from, like ABC-187). Looked up in that order, so a key beats a source key that looks the same.",
      example: "TRL-12",
    }),
});

export const issueParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description:
        "The item's id, its key (like TRL-12) or its source key (the key it had in the system it was imported from, like ABC-187).",
      example: "TRL-12",
    }),
});

export const productParam = z.object({
  key: z
    .string()
    .min(1)
    .openapi({
      param: { name: "key", in: "path" },
      description: "The product's key (like TRL, any case) or id.",
      example: "TRL",
    }),
});

export const projectParam = z.object({
  ref: z
    .string()
    .min(1)
    .openapi({
      param: { name: "ref", in: "path" },
      description:
        "The project's slug, like launch-q4, matched exactly. Deprecated: a product's key (like TRL) that matches no slug names the product, as this path did before projects; use /products/{key} for that.",
      example: "launch-q4",
    }),
});

export const projectSlugParam = z.object({
  slug: z
    .string()
    .min(1)
    .openapi({
      param: { name: "slug", in: "path" },
      description: "The project's slug, like launch-q4, matched exactly.",
      example: "launch-q4",
    }),
});

export const projectItemParam = projectSlugParam.extend({
  key: itemParam.shape.key,
});
