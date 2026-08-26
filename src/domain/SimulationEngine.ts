import type {
  AdvanceInput,
  CreateEpisodeInput,
  EngineEvent,
  EngineMetadata,
  EngineOption,
  EngineRawState,
  MakeDraftPickInput,
  NegotiateContractInput,
  PlayerSummary,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeEvaluation,
  TradeProposal,
} from "./types.js";

/**
 * Transport-independent contract for a headless simulation backend. Nothing in
 * this interface, or anything that implements it, may reference MCP types.
 * Implementations may run in-process (fakes, for unit tests) or be hosted in a
 * worker thread / child process (the real engine), which is why every method
 * is async even where a fake could answer synchronously.
 */
export type SimulationEngine = {
  readonly metadata: EngineMetadata;

  create(input: CreateEpisodeInput): Promise<void>;

  /** Full engine-normalized state for the active episode; not yet paginated or revision-stamped. */
  getRawState(): Promise<EngineRawState>;

  getOptions(): Promise<EngineOption[]>;

  /**
   * Public roster info for any team in the league, not just the user's own --
   * needed to construct a real trade proposal (an agent must be able to see
   * what a prospective trade partner actually has). Matches ordinary-play
   * visibility: rosters are public, unlike hidden opponent valuations.
   */
  getTeamRoster(tid: number): Promise<PlayerSummary[]>;

  /** Must not mutate state. */
  evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation>;

  executeTrade(proposal: TradeProposal): Promise<EngineEvent[]>;
  setLineup(input: SetLineupInput): Promise<EngineEvent[]>;
  releasePlayer(input: ReleasePlayerInput): Promise<EngineEvent[]>;
  negotiateContract(input: NegotiateContractInput): Promise<EngineEvent[]>;
  signFreeAgent(input: SignFreeAgentInput): Promise<EngineEvent[]>;
  makeDraftPick(input: MakeDraftPickInput): Promise<EngineEvent[]>;
  advance(input: AdvanceInput): Promise<EngineEvent[]>;

  exportSnapshot(): Promise<unknown>;
  importSnapshot(snapshot: unknown): Promise<void>;

  /** Releases all resources (worker threads, database handles, timers). */
  close(): Promise<void>;
};

export type SimulationEngineFactory = () => SimulationEngine;
