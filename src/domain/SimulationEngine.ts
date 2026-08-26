import type {
  AdvanceInput,
  CreateEpisodeInput,
  LeagueState,
  TradeEvaluation,
  TradeProposal,
} from "./types.js";

export interface SimulationEngine {
  readonly metadata: { name: string; version: string; commit?: string };

  create(input: CreateEpisodeInput): Promise<void>;
  getState(): Promise<Omit<LeagueState, "stateHash" | "revision" | "status">>;
  getOptions(): Promise<Array<Record<string, unknown>>>;
  evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation>;
  executeTrade(proposal: TradeProposal): Promise<Array<Record<string, unknown>>>;
  advance(input: AdvanceInput): Promise<Array<Record<string, unknown>>>;
  exportSnapshot(): Promise<unknown>;
  importSnapshot(snapshot: unknown): Promise<void>;
  close(): Promise<void>;
}

export type SimulationEngineFactory = () => SimulationEngine;

