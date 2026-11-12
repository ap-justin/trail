import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import type { KeyActor } from "../service/keys.js";
import { errorResponse } from "./errors.js";

export type ApiEnv = { Variables: { actor: KeyActor } };

/** A router whose request-validation failures are 422s in the shared error shape; `/api/v1`'s by default. */
export function createRouter<E extends Env = ApiEnv>() {
  return new OpenAPIHono<E>({
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
