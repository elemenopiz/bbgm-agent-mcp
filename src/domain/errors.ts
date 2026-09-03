export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "EPISODE_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INFORMATION_NOT_ALLOWED"
  | "ACTION_NOT_ALLOWED"
  | "STEP_LIMIT"
  | "HORIZON_REACHED"
  | "UNSUPPORTED_CONSTRAINT"
  | "UNSUPPORTED_OBJECTIVE"
  | "INVALID_PHASE"
  | "ILLEGAL_ACTION"
  | "INVARIANT_VIOLATION"
  | "ENGINE_ERROR"
  | "TIMEOUT"
  | "RESOURCE_LIMIT";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly rollbackRequired: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      rollbackRequired?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.rollbackRequired = options.rollbackRequired ?? true;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
