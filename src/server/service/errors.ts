/** Base of the errors the service throws on purpose; `code` is stable for clients to branch on. */
export abstract class ServiceError extends Error {
  abstract readonly code: string;
}

export class ForbiddenError extends ServiceError {
  readonly code = "forbidden";
  override readonly name = "ForbiddenError";
}

/** The key lacks the action the call needs. */
export class ForbiddenActionError extends ServiceError {
  readonly code = "forbidden_action";
  override readonly name = "ForbiddenActionError";
}

/** A key limited to some projects creating a project, or importing one outside them. */
export class ForbiddenScopeError extends ServiceError {
  readonly code = "forbidden_scope";
  override readonly name = "ForbiddenScopeError";
}

export class NotFoundError extends ServiceError {
  readonly code = "not_found";
  override readonly name = "NotFoundError";
}

export class ValidationError extends ServiceError {
  readonly code = "validation_failed";
  override readonly name = "ValidationError";
}

/** The write collides with what already exists: a row holding a unique value, or a count at its limit. */
export class ConflictError extends ServiceError {
  readonly code = "conflict";
  override readonly name = "ConflictError";
}

/** An idempotency key already stored for a different request by the same actor. */
export class IdempotencyKeyReusedError extends ServiceError {
  readonly code = "idempotency_key_reused";
  override readonly name = "IdempotencyKeyReusedError";
}

/** A photo whose bytes are not a PNG, JPEG or WebP. */
export class InvalidImageError extends ServiceError {
  readonly code = "invalid_image";
  override readonly name = "InvalidImageError";
}

/** A value over its size limit that no body limit caught first: a photo sent over MCP. */
export class PayloadTooLargeError extends ServiceError {
  readonly code = "payload_too_large";
  override readonly name = "PayloadTooLargeError";
}

/** A call made more often than its limit allows; `retryAfter` is the seconds until one would pass. */
export class RateLimitedError extends ServiceError {
  readonly code = "rate_limited";
  override readonly name = "RateLimitedError";
  constructor(
    message: string,
    readonly retryAfter: number,
  ) {
    super(message);
  }
}
