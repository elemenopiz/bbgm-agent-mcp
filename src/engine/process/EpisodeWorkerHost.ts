import { Worker } from "node:worker_threads";

import type { Request, Response } from "./protocol.js";

export type EpisodeWorkerHostOptions = {
  /** Path (or file:// URL string) to the worker script to spawn. */
  workerScript: string;
  /** Data made available to the worker via `worker_threads.workerData`. */
  workerData: Record<string, unknown>;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

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

  constructor(options: EpisodeWorkerHostOptions) {
    this.worker = new Worker(options.workerScript, {
      workerData: options.workerData,
    });

    this.worker.on("message", (response: Response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        const error = new Error(response.error.message);
        if (response.error.stack) error.stack = response.error.stack;
        pending.reject(error);
      } else {
        pending.resolve(response.result);
      }
    });

    this.worker.on("error", (error: Error) => {
      this.fatalError = error;
      this.rejectAllPending(error);
    });

    this.worker.on("exit", (code: number) => {
      if (code !== 0 && !this.terminated) {
        const error = new Error(
          `Episode worker exited unexpectedly with code ${code}`,
        );
        this.fatalError = error;
        this.rejectAllPending(error);
      }
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
      const request: Request =
        params === undefined ? { id, method } : { id, method, params };
      this.worker.postMessage(request);
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
