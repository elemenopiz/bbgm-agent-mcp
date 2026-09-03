import { resolve } from "node:path";

import { EpisodeWorkerHost } from "../process/EpisodeWorkerHost.js";
import type { Method } from "../process/protocol.js";
import type { SimulationEngine } from "../../domain/SimulationEngine.js";
import type {
  AdvanceInput,
  CreateEpisodeInput,
  EngineEvent,
  EngineMetadata,
  EngineOption,
  EngineRawState,
  MakeDraftPickInput,
  NegotiateContractInput,
  PlayerDetail,
  PlayerSummary,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeEvaluation,
  TradeProposal,
} from "../../domain/types.js";

export const BASKETBALL_GM_ENGINE_METADATA: EngineMetadata = {
  name: "basketball-gm",
  version: "5.1.0",
  commit: "4ee432c5b9097ed978749a049fff5823711690dc",
};

/**
 * Main-thread implementation of SimulationEngine backed by the real
 * Basketball GM engine, running in its own `node:worker_threads` Worker
 * (one per episode -- see EpisodeWorkerHost's doc comment for why that
 * matters for Math.random/state isolation).
 *
 * This class is deliberately thin: all worker lifecycle/request-correlation
 * logic lives in the generic EpisodeWorkerHost, and all zengm-specific logic
 * lives in engine-bridge/entry.ts + src/engine/bbgm/adapter.ts (which run
 * inside the worker, not here). This class's only job is to type each
 * SimulationEngine method as a `host.call(method, params)`.
 */
export class BasketballGmEngine implements SimulationEngine {
  readonly metadata: EngineMetadata = BASKETBALL_GM_ENGINE_METADATA;

  private readonly host: EpisodeWorkerHost;

  constructor(options?: { bridgePath?: string; sourceDir?: string }) {
    const bridgePath =
      options?.bridgePath ??
      process.env["BBGM_BRIDGE_PATH"] ??
      resolve(".cache/bbgm-bridge/bridge.mjs");
    const sourceDir =
      options?.sourceDir ??
      process.env["BBGM_SOURCE_DIR"] ??
      resolve(".cache/zengm");
    const resourceLimits = parseLimit(
      process.env["BBGM_ENGINE_MAX_OLD_GEN_MB"],
    );
    const callTimeoutMs = parseTimeout(process.env["BBGM_ENGINE_TIMEOUT_MS"]);
    this.host = new EpisodeWorkerHost({
      workerScript: bridgePath,
      workerData: { sourceDir: resolve(sourceDir) },
      ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
      ...(resourceLimits === undefined
        ? {}
        : { resourceLimits: { maxOldGenerationSizeMb: resourceLimits } }),
    });
  }

  async create(input: CreateEpisodeInput): Promise<void> {
    await this.call<void>("create", input);
  }

  async getRawState(): Promise<EngineRawState> {
    return this.call<EngineRawState>("getRawState");
  }

  async getTeamRoster(tid: number): Promise<PlayerSummary[]> {
    return this.call<PlayerSummary[]>("getTeamRoster", { tid });
  }

  async getPlayer(pid: number): Promise<PlayerDetail> {
    return this.call<PlayerDetail>("getPlayer", { pid });
  }

  async getOptions(): Promise<EngineOption[]> {
    return this.call<EngineOption[]>("getOptions");
  }

  async evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation> {
    return this.call<TradeEvaluation>("evaluateTrade", proposal);
  }

  async executeTrade(proposal: TradeProposal): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("executeTrade", proposal);
  }

  async setLineup(input: SetLineupInput): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("setLineup", input);
  }

  async releasePlayer(input: ReleasePlayerInput): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("releasePlayer", input);
  }

  async negotiateContract(
    input: NegotiateContractInput,
  ): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("negotiateContract", input);
  }

  async signFreeAgent(input: SignFreeAgentInput): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("signFreeAgent", input);
  }

  async makeDraftPick(input: MakeDraftPickInput): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("makeDraftPick", input);
  }

  async advance(input: AdvanceInput): Promise<EngineEvent[]> {
    return this.call<EngineEvent[]>("advance", input);
  }

  async exportSnapshot(): Promise<unknown> {
    return this.call<unknown>("exportSnapshot");
  }

  async importSnapshot(snapshot: unknown): Promise<void> {
    await this.call<void>("importSnapshot", snapshot);
  }

  async close(): Promise<void> {
    try {
      await this.call<void>("close");
    } finally {
      await this.host.terminate();
    }
  }

  private call<T>(method: Method, params?: unknown): Promise<T> {
    return this.host.call<T>(method, params);
  }
}

const parsePositiveInteger = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const parseTimeout = (value: string | undefined): number | undefined =>
  parsePositiveInteger(value);

const parseLimit = (value: string | undefined): number | undefined =>
  parsePositiveInteger(value);
