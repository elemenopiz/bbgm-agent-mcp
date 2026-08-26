/**
 * Wire protocol shared between the main thread (EpisodeWorkerHost) and an
 * episode worker (e.g. engine-bridge/entry.ts). This module is intentionally
 * engine-agnostic: it knows nothing about Basketball GM or zengm.
 *
 * Every field here is a plain, structurally-typed value so it survives
 * structured-clone across the worker_threads boundary without any special
 * serialization step.
 */

/** Every SimulationEngine method that can be invoked over the wire. */
export type Method =
  | "create"
  | "getRawState"
  | "getOptions"
  | "evaluateTrade"
  | "executeTrade"
  | "setLineup"
  | "releasePlayer"
  | "negotiateContract"
  | "signFreeAgent"
  | "makeDraftPick"
  | "advance"
  | "exportSnapshot"
  | "importSnapshot"
  | "close";

/**
 * A single RPC request sent to the worker. `method` is a plain `string`
 * (rather than `Method`) so that EpisodeWorkerHost -- which is generic and
 * must not depend on Basketball GM's specific method list -- can construct
 * and type these without importing `Method`. Call sites that *do* know the
 * concrete engine (BasketballGmEngine.ts) should constrain the strings they
 * pass using `Method` at their own layer.
 */
export type Request = {
  id: number;
  method: string;
  params?: unknown;
};

export type ResponseError = {
  message: string;
  stack?: string;
};

/**
 * A single RPC response from the worker. Exactly one of `result`/`error`
 * is meaningful for a given response; both are optional on the wire type
 * because a successful call with no return value legitimately has neither.
 */
export type Response = {
  id: number;
  result?: unknown;
  error?: ResponseError;
};
