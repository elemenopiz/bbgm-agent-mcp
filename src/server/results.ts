import { DomainError } from "../domain/errors.js";

export const success = <T extends Record<string, unknown>>(value: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

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
            code: "ENGINE_ERROR",
            message: error instanceof Error ? error.message : "Unknown engine error",
            retryable: false,
          },
        };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(normalized) }],
    isError: true as const,
  };
};

