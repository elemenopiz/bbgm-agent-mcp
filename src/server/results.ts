import { DomainError, type DomainErrorCode } from "../domain/errors.js";

type OutputSchema = {
  safeParse(value: unknown): { success: boolean };
};

const TIMEOUT_MESSAGE =
  "The engine worker timed out; resume the quarantined episode before retrying";
const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_ENTRIES = 64;
const MAX_DETAIL_ITEMS = 64;
const MAX_DETAIL_STRING_LENGTH = 1_024;

type SafeDetail =
  null | boolean | number | string | unknown[] | Record<string, unknown>;

/**
 * DomainError details are intentionally useful to an agent, but they are
 * still an untrusted boundary. Keep the allowlisted JSON-like subset and
 * bound depth/size so a future engine error cannot leak objects, paths, or
 * circular structures through an MCP result.
 */
const sanitizeDetail = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): SafeDetail | undefined => {
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_STRING_LENGTH
      ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}…`
      : value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular detail omitted]";
  if (depth >= MAX_DETAIL_DEPTH) return "[detail truncated]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_DETAIL_ITEMS)
        .map((item) => sanitizeDetail(item, depth + 1, seen))
        .filter((item): item is SafeDetail => item !== undefined);
    }

    const result = Object.create(null) as Record<string, SafeDetail>;
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(value).sort().slice(0, MAX_DETAIL_ENTRIES)) {
      const item = sanitizeDetail(object[key], depth + 1, seen);
      if (item !== undefined) result[key] = item;
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

const sanitizeDetails = (
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (details === undefined) return undefined;
  const sanitized = sanitizeDetail(details, 0, new WeakSet<object>());
  return sanitized !== undefined &&
    sanitized !== null &&
    typeof sanitized === "object" &&
    !Array.isArray(sanitized)
    ? sanitized
    : undefined;
};

const DOMAIN_ERROR_CODES = new Set<DomainErrorCode>([
  "VALIDATION_ERROR",
  "EPISODE_NOT_FOUND",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INFORMATION_NOT_ALLOWED",
  "ACTION_NOT_ALLOWED",
  "STEP_LIMIT",
  "HORIZON_REACHED",
  "UNSUPPORTED_CONSTRAINT",
  "UNSUPPORTED_OBJECTIVE",
  "INVALID_PHASE",
  "ILLEGAL_ACTION",
  "INVARIANT_VIOLATION",
  "ENGINE_ERROR",
  "TIMEOUT",
  "RESOURCE_LIMIT",
]);

/** Rehydrates safe domain fields from an error that crossed the worker RPC boundary. */
const transportDomainFailure = (error: unknown) => {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as Error & {
    code?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
  if (
    typeof candidate.code !== "string" ||
    !DOMAIN_ERROR_CODES.has(candidate.code as DomainErrorCode) ||
    candidate.code === "ENGINE_ERROR" ||
    candidate.code === "TIMEOUT"
  ) {
    return undefined;
  }
  const details =
    typeof candidate.details === "object" &&
    candidate.details !== null &&
    !Array.isArray(candidate.details)
      ? sanitizeDetails(candidate.details as Record<string, unknown>)
      : undefined;
  return {
    error: {
      code: candidate.code as DomainErrorCode,
      message: candidate.message,
      retryable: candidate.retryable === true,
      ...(details === undefined ? {} : { details }),
    },
  };
};

/**
 * Every tool returns compact JSON in a text block (for clients without
 * structured-content support) alongside structuredContent (for clients with
 * it). The top level is always a plain object for maximum compatibility.
 */
export const success = <T extends Record<string, unknown>>(
  value: T,
  schema?: OutputSchema,
) => {
  if (schema && !schema.safeParse(value).success) {
    throw new DomainError(
      "ENGINE_ERROR",
      "The server produced a response that failed its declared output schema",
    );
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
};

/**
 * Converts recoverable domain failures into `isError: true` tool results with
 * a stable error code. Never includes a stack trace, local path, or raw
 * engine object -- only what DomainError chose to expose via `details`.
 */
export const failure = (error: unknown) => {
  const workerFailure =
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "TIMEOUT"
      ? {
          error: {
            code: "TIMEOUT" as const,
            message: TIMEOUT_MESSAGE,
            retryable: true,
          },
        }
      : undefined;
  const normalized =
    workerFailure ??
    (error instanceof DomainError
      ? {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(sanitizeDetails(error.details) === undefined
              ? {}
              : { details: sanitizeDetails(error.details) }),
          },
        }
      : (transportDomainFailure(error) ?? {
          error: {
            code: "ENGINE_ERROR" as const,
            message: "Internal engine error",
            retryable: false,
          },
        }));
  return {
    content: [{ type: "text" as const, text: JSON.stringify(normalized) }],
    isError: true as const,
  };
};
