import { OpenAPIHono } from "@hono/zod-openapi";
import type { Actor } from "../service/keys.js";
import { errorResponse } from "./errors.js";

export type ApiEnv = { Variables: { actor: Actor } };

/** An `/api/v1` router whose request-validation failures are 422s in the shared error shape. */
export function createRouter() {
  return new OpenAPIHono<ApiEnv>({
    defaultHook: (result, c) => {
      if (result.success) return;
      const message = result.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.join(".")}: ${issue.message}`,
        )
        .join("; ");
      return errorResponse(c, 422, "validation_failed", message);
    },
  });
}
