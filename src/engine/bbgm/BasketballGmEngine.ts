import { Worker } from "node:worker_threads";
import { resolve } from "node:path";

import type { SimulationEngine } from "../../domain/SimulationEngine.js";
import type {
  AdvanceInput,
  CreateEpisodeInput,
  LeagueState,
  TradeEvaluation,
  TradeProposal,
} from "../../domain/types.js";

type Response = { id: number; result?: unknown; error?: { message?: string; stack?: string } };

export class BasketballGmEngine implements SimulationEngine {
  readonly metadata = {
    name: "basketball-gm",
    version: "5.1.0",
    commit: "4ee432c5b9097ed978749a049fff5823711690dc",
  };

  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private input?: CreateEpisodeInput;

  constructor(bridgePath = process.env["BBGM_BRIDGE_PATH"] ?? resolve(".cache/bbgm-bridge/bridge.mjs")) {
    this.worker = new Worker(bridgePath, {
      workerData: {
        sourceDir: resolve(process.env["BBGM_SOURCE_DIR"] ?? ".cache/zengm"),
      },
    });
    this.worker.on("message", (response: Response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        const error = new Error(response.error.message ?? "Basketball GM bridge failed");
        if (response.error.stack) error.stack = response.error.stack;
        pending.reject(error);
      } else {
        pending.resolve(response.result);
      }
    });
    this.worker.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async create(input: CreateEpisodeInput): Promise<void> {
    this.input = input;
    await this.call("create", input);
  }

  async getState(): Promise<Omit<LeagueState, "stateHash" | "revision" | "status">> {
    const input = this.requireInput();
    return this.call("getState", {
      episodeId: input.episodeId,
      scenarioId: input.scenarioId,
      seed: input.seed,
    });
  }

  async getOptions(): Promise<Array<Record<string, unknown>>> {
    return this.call("getOptions");
  }

  async evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation> {
    return this.call("evaluateTrade", proposal);
  }

  async executeTrade(proposal: TradeProposal): Promise<Array<Record<string, unknown>>> {
    return this.call("executeTrade", proposal);
  }

  async advance(input: AdvanceInput): Promise<Array<Record<string, unknown>>> {
    return this.call("advance", input);
  }

  async exportSnapshot(): Promise<unknown> {
    return this.call("exportSnapshot");
  }

  async importSnapshot(snapshot: unknown): Promise<void> {
    await this.call("importSnapshot", snapshot);
  }

  async close(): Promise<void> {
    try {
      await this.call("close");
    } finally {
      await this.worker.terminate();
    }
  }

  private call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject,
      });
      this.worker.postMessage(params === undefined ? { id, method } : { id, method, params });
    });
  }

  private requireInput(): CreateEpisodeInput {
    if (!this.input) throw new Error("Basketball GM engine has not been initialized");
    return this.input;
  }
}
