import type {
  AdvanceInput,
  AdvertiseOnTradingBlockInput,
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
  TradeProposalsData,
  TradingBlockData,
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

  /**
   * Deep detail for a single player -- ratings history, stats history,
   * contract schedule, awards, draft info, and injury history. Must not
   * mutate state. Never throws on an unknown or missing pid; returns a
   * partial/empty PlayerDetail instead (see adapter.ts's getPlayer()).
   */
  getPlayer(pid: number): Promise<PlayerDetail>;

  /** Must not mutate state. */
  evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation>;

  /**
   * What the user has advertised on the trading block (if anything), the
   * offers judged against it, and the roster players / owned picks eligible
   * to advertise. Must not mutate state. See adapter.ts's getTradingBlock().
   */
  getTradingBlock(): Promise<TradingBlockData>;

  /**
   * AI-initiated trade offers the user did not solicit. Must not mutate
   * state. An offer here can be accepted via executeTrade -- there is no
   * separate accept path; see adapter.ts's getTradeProposals().
   */
  getTradeProposals(): Promise<TradeProposalsData>;

  executeTrade(proposal: TradeProposal): Promise<EngineEvent[]>;
  advertiseOnTradingBlock(
    input: AdvertiseOnTradingBlockInput,
  ): Promise<EngineEvent[]>;
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
