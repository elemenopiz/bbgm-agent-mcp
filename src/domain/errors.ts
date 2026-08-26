export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "EPISODE_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INVALID_PHASE"
  | "ILLEGAL_ACTION"
  | "INVARIANT_VIOLATION"
  | "ENGINE_ERROR"
  | "RESOURCE_LIMIT";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

