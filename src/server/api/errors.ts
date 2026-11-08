import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiError } from "../../shared/schemas.js";
import {
  ForbiddenError,
  NotFoundError,
  ServiceError,
  ValidationError,
} from "../service/errors.js";

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}

function statusOf(error: ServiceError): ContentfulStatusCode {
  if (error instanceof ForbiddenError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ValidationError) return 422;
  return 400;
}

const httpCodes: Partial<Record<number, string>> = {
  400: "bad_request",
  415: "unsupported_media_type",
};

export const handleError: ErrorHandler = (err, c) => {
  if (err instanceof ServiceError) {
    return errorResponse(c, statusOf(err), err.code, err.message);
  }
  if (err instanceof HTTPException) {
    // a prepared response (the bearer middleware's 401) is already in the shared shape
    if (err.res) return err.getResponse();
    return errorResponse(
      c,
      err.status,
      httpCodes[err.status] ?? "http_error",
      err.message,
    );
  }
  console.error(`unhandled error on ${c.req.method} ${c.req.path}`, err);
  return errorResponse(c, 500, "internal", "internal server error");
};

export const handleNotFound = (c: Context) =>
  errorResponse(c, 404, "not_found", `no route ${c.req.method} ${c.req.path}`);
