import { Worker } from "node:worker_threads";

import type { Request, Response } from "./protocol.js";

export type EpisodeWorkerHostOptions = {
  /** Path (or file:// URL string) to the worker script to spawn. */
  workerScript: string;
  /** Data made available to the worker via `worker_threads.workerData`. */
  workerData: Record<string, unknown>;
  /** Maximum time a single worker call may remain unresolved. */
  callTimeoutMs?: number;
  /** Optional V8 resource ceilings for this worker. */
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  };
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type WorkerHostErrorCode = "TIMEOUT" | "ENGINE_ERROR";

export class WorkerHostError extends Error {
  readonly code: WorkerHostErrorCode;
  readonly retryable: boolean;

  constructor(
    code: WorkerHostErrorCode,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "WorkerHostError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Generic main-thread host for a single `node:worker_threads` Worker running
 * one episode. This class knows nothing about basketball or zengm -- it only
 * spawns the worker, correlates request ids to responses, and surfaces
 * worker lifecycle failures (uncaught errors, unexpected exit) to whichever
 * calls are still in flight. It is the reusable half of the old
 * BasketballGmEngine's worker-management code; the basketball-specific half
 * now lives in BasketballGmEngine.ts, which composes this class.
 *
 * Each episode gets its own EpisodeWorkerHost / Worker instance, which is
 * what keeps one episode's Math.random and in-memory engine state from
 * leaking into another's (rule: "Each episode must run in its own Node
 * worker thread").
 */
export class EpisodeWorkerHost {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private terminated = false;
  private fatalError: Error | undefined;
  private readonly callTimeoutMs: number;

  constructor(options: EpisodeWorkerHostOptions) {
    this.worker = new Worker(options.workerScript, {
      workerData: options.workerData,
      ...(options.resourceLimits === undefined
        ? {}
        : { resourceLimits: options.resourceLimits }),
    });
    this.callTimeoutMs = options.callTimeoutMs ?? 120_000;

    this.worker.on("message", (response: Response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (response.error) {
        const error = new Error(response.error.message);
        if (response.error.stack) error.stack = response.error.stack;
        Object.assign(error, {
          ...(response.error.code === undefined
            ? {}
            : { code: response.error.code }),
          ...(response.error.retryable === undefined
            ? {}
            : { retryable: response.error.retryable }),
          ...(response.error.rollbackRequired === undefined
            ? {}
            : { rollbackRequired: response.error.rollbackRequired }),
          ...(response.error.details === undefined
            ? {}
            : { details: response.error.details }),
        });
        pending.reject(error);
      } else {
        pending.resolve(response.result);
      }
    });

    this.worker.on("error", (error: Error) => {
      const workerError = new WorkerHostError("ENGINE_ERROR", error.message);
      if (error.stack !== undefined) workerError.stack = error.stack;
      this.fatalError = workerError;
      this.rejectAllPending(workerError);
    });

    this.worker.on("exit", (code: number) => {
      if (this.terminated || this.fatalError) return;
      const error = new WorkerHostError(
        "ENGINE_ERROR",
        `Episode worker exited unexpectedly with code ${code}`,
      );
      this.fatalError = error;
      this.rejectAllPending(error);
    });
  }

  /**
   * Invokes `method` in the worker and resolves with its result. Requests
   * are correlated to responses by an incrementing id, so multiple calls may
   * be in flight from the caller's perspective at once -- it is the
   * worker's own responsibility (see engine-bridge/entry.ts's serialized
   * command queue) to actually process them one at a time.
   */
  call<T>(method: string, params?: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.terminated)
      return Promise.reject(
        new Error("EpisodeWorkerHost has already been terminated"),
      );

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      const pending = this.pending.get(id);
      if (this.callTimeoutMs > 0 && pending) {
        pending.timer = setTimeout(() => {
          const timeout = new WorkerHostError(
            "TIMEOUT",
            `Episode worker call timed out after ${this.callTimeoutMs}ms`,
            { retryable: true },
          );
          this.fatalError = timeout;
          this.rejectAllPending(timeout);
          this.terminated = true;
          void this.worker.terminate();
        }, this.callTimeoutMs);
      }
      const request: Request =
        params === undefined ? { id, method } : { id, method, params };
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        if (pending?.timer) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Terminates the worker and rejects any calls still in flight. */
  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.rejectAllPending(new Error("EpisodeWorkerHost was terminated"));
    await this.worker.terminate();
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
