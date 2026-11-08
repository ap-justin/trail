/** Base of the errors the service throws on purpose; `code` is stable for clients to branch on. */
export abstract class ServiceError extends Error {
  abstract readonly code: string;
}

export class ForbiddenError extends ServiceError {
  readonly code = "forbidden";
  override readonly name = "ForbiddenError";
}

export class NotFoundError extends ServiceError {
  readonly code = "not_found";
  override readonly name = "NotFoundError";
}

export class ValidationError extends ServiceError {
  readonly code = "validation_failed";
  override readonly name = "ValidationError";
}
