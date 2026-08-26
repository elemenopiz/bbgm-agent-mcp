import { DomainError } from "../domain/errors.js";

/**
 * Every tool returns compact JSON in a text block (for clients without
 * structured-content support) alongside structuredContent (for clients with
 * it). The top level is always a plain object for maximum compatibility.
 */
export const success = <T extends Record<string, unknown>>(value: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

/**
 * Converts recoverable domain failures into `isError: true` tool results with
 * a stable error code. Never includes a stack trace, local path, or raw
 * engine object -- only what DomainError chose to expose via `details`.
 */
export const failure = (error: unknown) => {
  const normalized =
    error instanceof DomainError
      ? {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        }
      : {
          error: {
            code: "ENGINE_ERROR" as const,
            message:
              error instanceof Error ? error.message : "Unknown engine error",
            retryable: false,
          },
        };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(normalized) }],
    isError: true as const,
  };
};
