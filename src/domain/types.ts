export const STATE_SCHEMA_VERSION = "1" as const;

export type EpisodeStatus = "active" | "ended" | "quarantined";

export const DEFAULT_ALLOWED_INFORMATION = [
  "overview",
  "roster",
  "finances",
  "standings",
  "schedule",
  "free_agents",
  "draft",
  "transactions",
  "objectives",
  "constraints",
  "options",
  "player_detail",
  "trading_block",
  "trade_proposals",
] as const;

export const DEFAULT_ALLOWED_ACTIONS = [
  "evaluate_trade",
  "execute_trade",
  "set_lineup",
  "release_player",
  "negotiate_contract",
  "sign_free_agent",
  "make_draft_pick",
  "advance",
  "create_checkpoint",
  "list_checkpoints",
  "restore_checkpoint",
  "advertise_on_trading_block",
] as const;

export const ADVANCE_TARGETS = [
  "next_game",
  "next_decision",
  "days",
  "games",
  "week",
  "month",
  "one_pick",
  "phase",
  "season_end",
  "until_all_star_game",
  "until_trade_deadline",
  "until_playoffs",
  "until_end_of_round",
  "until_end_of_play_in",
  "through_playoffs",
  "until_draft",
  "until_next_pick",
  "until_resign_players",
  "until_free_agency",
  "until_preseason",
  "until_regular_season",
] as const;
export type AdvanceTarget = (typeof ADVANCE_TARGETS)[number];

/**
 * Full typed advance surface exposed by the wrapper. Scenario manifests may
 * narrow this for a specific study, but the default remains close to the
 * upstream play menu so the environment does not encode a strategy for the
 * evaluated policy.
 */
export const DEFAULT_ALLOWED_ADVANCE_TARGETS: AdvanceTarget[] = [
  "next_game",
  "next_decision",
  "days",
  "games",
  "week",
  "month",
  "one_pick",
  "phase",
  "season_end",
  "until_all_star_game",
  "until_trade_deadline",
  "until_playoffs",
  "until_end_of_round",
  "until_end_of_play_in",
  "through_playoffs",
  "until_draft",
  "until_next_pick",
  "until_resign_players",
  "until_free_agency",
  "until_preseason",
  "until_regular_season",
];

/**
 * Public-MCP preset. This intentionally preserves the full human-facing
 * pacing surface, including day/week/month and explicit counts. Safety comes
 * from bounded counts, episode budgets, typed mutations, revision checks,
 * timeouts, and rollback—not from curating the policy's strategic choices.
 * The wrapper still omits upstream's automatic `untilEnd` draft completion,
 * because it would silently make a mandatory user decision on the agent's
 * behalf.
 */
export const PUBLIC_MCP_ALLOWED_ADVANCE_TARGETS: AdvanceTarget[] = [
  "next_game",
  "next_decision",
  "days",
  "games",
  "week",
  "month",
  "one_pick",
  "phase",
  "season_end",
  "until_all_star_game",
  "until_trade_deadline",
  "until_playoffs",
  "until_end_of_round",
  "until_end_of_play_in",
  "through_playoffs",
  "until_draft",
  "until_next_pick",
  "until_resign_players",
  "until_free_agency",
  "until_preseason",
  "until_regular_season",
];

export type ScenarioPolicy = {
  allowedInformation: string[];
  allowedActions: string[];
  /** Optional finer-grained allowlist for the advance tool. */
  allowedAdvanceTargets?: AdvanceTarget[] | undefined;
  maxSteps?: number | undefined;
  horizonSeasons?: number | undefined;
};

export const PHASES = [
  "preseason",
  "regular_season",
  "playoffs",
  "draft_lottery",
  "draft",
  "resigning",
  "free_agency",
] as const;
export type Phase = (typeof PHASES)[number];

/** Employment is an engine fact, not an evaluator prediction. Engines that
 * cannot expose the upstream firing state must leave this undefined rather
 * than making a claim about whether the GM is still employed. */
export type EmploymentStatus = "employed" | "fired" | "unknown";

export type EngineMetadata = {
  name: string;
  version: string;
  commit?: string;
};

// ---------------------------------------------------------------------------
// Players, contracts, picks
// ---------------------------------------------------------------------------

export type PlayerRole = "starter" | "rotation" | "bench" | "inactive";

export type PlayerSummary = {
  pid: number;
  name: string;
  age: number;
  position: string;
  overall: number;
  potential: number;
  contractAmount: number;
  contractExpires: number;
  injuryGamesRemaining: number;
  role: PlayerRole;
  rosterOrder: number;
  /** Enrichment sourced from zengm's own roster view rather than raw rows.
   * Optional because it is only populated for views backed by that call
   * (see docs/INFORMATION_AUDIT.md). */
  /** Year-over-year change in overall / potential -- the development curve. */
  overallChange?: number;
  potentialChange?: number;
  /** zengm skill tags, e.g. "3" (shooter), "B" (ball handler), "Dp". */
  skills?: string[];
  untradable?: boolean;
  /** Mood: whether the player would negotiate now, and the amount they would
   * actually accept -- previously invisible, forcing brute-force signing. */
  willingToNegotiate?: boolean;
  probWilling?: number;
  askingAmount?: number;
  yearsWithTeam?: number;
  gamesPlayed?: number;
  minutesPerGame?: number;
  pointsPerGame?: number;
  reboundsPerGame?: number;
  assistsPerGame?: number;
  per?: number;
};

/**
 * The PlayerSummary fields above that are derived presentation enrichment
 * sourced from zengm's roster view rather than engine state of record.
 *
 * These are excluded from the episode state hash. Mood-derived floats -- most
 * notably `probWilling` -- are not bit-reproducible across a snapshot
 * export/import round trip (observed drift at the eighth decimal place), so
 * including them made rollback verification and replay non-deterministic: a
 * correctly restored snapshot could hash differently from the pre-action
 * state and quarantine a healthy episode. Every field here is a pure function
 * of state that IS hashed, so dropping them loses no change detection.
 */
export const PLAYER_SUMMARY_DERIVED_FIELDS = [
  "overallChange",
  "potentialChange",
  "skills",
  "untradable",
  "willingToNegotiate",
  "probWilling",
  "askingAmount",
  "yearsWithTeam",
  "gamesPlayed",
  "minutesPerGame",
  "pointsPerGame",
  "reboundsPerGame",
  "assistsPerGame",
  "per",
] as const satisfies readonly (keyof PlayerSummary)[];

// ---------------------------------------------------------------------------
// Player detail (bbgm_get_player) -- the "click into a player" view. Sourced
// from zengm's own player worker view (src/worker/views/player.ts), which
// returns full ratings/stats history in one call; see adapter.ts's
// getPlayer() for the mapping. Deliberately excludes zengm's internal
// `value` composite valuation -- the same function the trade AI uses to
// judge offers, so exposing it would leak the counterparty's utility
// function to the policy.
// ---------------------------------------------------------------------------

/** One season's individual ratings. Field names mirror zengm's own
 * abbreviations (see docs/INFORMATION_AUDIT.md) except `str`, which maps
 * from zengm's `stre`. Every rating is optional -- older/partial data may be
 * missing individual fields. */
export type PlayerRatingsSeason = {
  season: number;
  teamId?: number;
  age?: number;
  overall?: number;
  potential?: number;
  hgt?: number;
  str?: number;
  spd?: number;
  jmp?: number;
  endu?: number;
  ins?: number;
  dnk?: number;
  ft?: number;
  fg?: number;
  tp?: number;
  oiq?: number;
  diq?: number;
  drb?: number;
  pss?: number;
  reb?: number;
  skills?: string[];
};

/** One season's (or one playoffs run's) basic + advanced production, keyed
 * by the `playoffs` flag so a single season can appear twice (regular +
 * playoffs) and mid-season trades can appear per-team plus a merged total. */
export type PlayerStatsSeason = {
  season: number;
  teamId?: number;
  playoffs: boolean;
  gamesPlayed?: number;
  minutesPerGame?: number;
  pointsPerGame?: number;
  reboundsPerGame?: number;
  assistsPerGame?: number;
  stealsPerGame?: number;
  blocksPerGame?: number;
  turnoversPerGame?: number;
  fieldGoalPct?: number;
  threePointPct?: number;
  freeThrowPct?: number;
  /** Player Efficiency Rating. */
  per?: number;
  offensiveWinShares?: number;
  defensiveWinShares?: number;
  winShares?: number;
  winSharesPer48?: number;
  offensiveBPM?: number;
  defensiveBPM?: number;
  bpm?: number;
  vorp?: number;
  trueShootingPct?: number;
  usagePct?: number;
};

export type PlayerContractYear = {
  season: number;
  /** Millions of dollars. */
  amount: number;
  type: "past" | "current" | "future";
};

export type PlayerAward = {
  season: number;
  type: string;
};

/** A past injury. `games` is games missed, not games remaining -- see
 * `currentInjury` on PlayerDetail for the player's present availability. */
export type PlayerInjuryHistoryEntry = {
  season?: number;
  type: string;
  games?: number;
};

export type PlayerDraftInfo = {
  year?: number;
  round?: number;
  pick?: number;
  originalTeamId?: number;
};

export type PlayerDetail = {
  pid: number;
  name?: string;
  age?: number;
  position?: string;
  teamId?: number;
  ratingsHistory: PlayerRatingsSeason[];
  statsHistory: PlayerStatsSeason[];
  /** Millions of dollars. */
  contractAmount?: number;
  contractExpires?: number;
  contractSchedule: PlayerContractYear[];
  awards: PlayerAward[];
  draft?: PlayerDraftInfo;
  currentInjury?: { type: string; gamesRemaining: number };
  injuryHistory: PlayerInjuryHistoryEntry[];
};

export type GetPlayerInput = {
  episodeId: string;
  pid: number;
};

export type GetPlayerResult = {
  episodeId: string;
  revision: number;
  player: PlayerDetail;
};

export type ProspectSummary = {
  pid: number;
  name: string;
  age: number;
  position: string;
  scoutedOverall: number;
  scoutedPotential: number;
  draftYear: number;
};

export type DraftPickSummary = {
  dpid: number;
  season: number;
  /** Draft round as stored by BBGM; custom leagues may have more than two. */
  round: number;
  originalTeamId: number;
  currentTeamId: number;
  protection?: string;
};

// ---------------------------------------------------------------------------
// Team / league facts
// ---------------------------------------------------------------------------

export type TeamSummary = {
  tid: number;
  name: string;
  abbrev: string;
  won: number;
  lost: number;
  conference: string;
  division: string;
  standing: number;
  payroll: number;
  salaryCap: number;
  capSpace: number;
  luxuryTaxThreshold: number;
  hardCapActive: boolean;
  /** Minimum contract. Over the cap, only minimum-salary signings are legal
   * (zengm contractNegotiation/accept.ts). Without this the policy cannot
   * know a legal signing exists. */
  minContract: number;
  maxContract: number;
};

export type TeamStanding = {
  tid: number;
  name: string;
  abbrev: string;
  won: number;
  lost: number;
  conference: string;
  division: string;
  rank: number;
  gamesBehind: number;
};

export type ScheduledGame = {
  gid: number;
  season: number;
  day: number;
  homeTeamId: number;
  awayTeamId: number;
  played: boolean;
  homeScore?: number;
  awayScore?: number;
};

export type TransactionRecord = {
  transactionId: number;
  season: number;
  day: number;
  type: "trade" | "release" | "sign" | "draft" | "contract_extension";
  description: string;
  teamIds: number[];
};

// ---------------------------------------------------------------------------
// Constraints / objectives
// ---------------------------------------------------------------------------

export type ConstraintStatus = {
  code: string;
  kind: "hard" | "soft";
  satisfied: boolean;
  message: string;
};

export type ObjectiveStatus = {
  code: string;
  description: string;
  weight: number;
  currentValue: number;
  targetValue?: number;
};

export type ConstraintDefinition = {
  code: string;
  description: string;
};

export type ObjectiveDefinition = {
  code: string;
  description: string;
  weight: number;
  targetValue?: number | undefined;
};

export type ScenarioConstraintSpec = {
  hard: ConstraintDefinition[];
  soft: ObjectiveDefinition[];
};

// ---------------------------------------------------------------------------
// Engine-facing raw state (pre-view-slicing, engine-normalized but not yet
// paginated / revision-stamped -- that is the domain layer's job)
// ---------------------------------------------------------------------------

export type EngineRawState = {
  /** Roster bounds as configured in the league (zengm minRosterSize /
   * maxRosterSize). Optional: falls back to the basketball defaults. */
  rosterMin?: number;
  rosterMax?: number;
  season: number;
  phase: Phase;
  day?: number;
  employmentStatus?: EmploymentStatus;
  userTeam: TeamSummary;
  /** Episode-wide record used by research metrics; userTeam is current-season state. */
  cumulativeRecord?: { won: number; lost: number };
  roster: PlayerSummary[];
  freeAgents: PlayerSummary[];
  draftProspects: ProspectSummary[];
  /** Complete current-owner ledger, including picks held by other teams. */
  draftPicks: DraftPickSummary[];
  ownedPicks: DraftPickSummary[];
  standings: TeamStanding[];
  schedule: ScheduledGame[];
  recentTransactions: TransactionRecord[];
  legalActionCategories: string[];
  nextDecision: string;
};

export type EngineEvent = { type: string } & Record<string, unknown>;
export type EngineOption = { type: string } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Episode lifecycle
// ---------------------------------------------------------------------------

export type CreateEpisodeInput = {
  episodeId: string;
  scenarioId: string;
  seed: string;
  userTeamId: number;
  startingSeason: number;
  constraints: ScenarioConstraintSpec;
  scenarioPolicy?: ScenarioPolicy;
  /** Internal/evaluator-only starting snapshot; never exposed by the MCP create tool. */
  initialSnapshot?: unknown;
};

export type EpisodeMetadata = {
  episodeId: string;
  scenarioId: string;
  seed: string;
  engine: EngineMetadata;
  userTeamId: number;
  season: number;
  phase: Phase;
  revision: number;
  createdAt: string;
  lastAccessedAt: string;
  stateHash: string;
  trajectoryPath: string;
  status: EpisodeStatus;
  constraints: ScenarioConstraintSpec;
};

// ---------------------------------------------------------------------------
// get_state views
// ---------------------------------------------------------------------------

export const GET_STATE_VIEWS = [
  "overview",
  "roster",
  "finances",
  "standings",
  "schedule",
  "free_agents",
  "draft",
  "transactions",
  "objectives",
  "constraints",
  "trading_block",
  "trade_proposals",
] as const;
export type GetStateViewName = (typeof GET_STATE_VIEWS)[number];

export type GetStateInput = {
  episodeId: string;
  view: GetStateViewName;
  cursor?: number | undefined;
  limit?: number | undefined;
  /** Only meaningful for view="roster": which team's roster to read. Defaults to the user's own team. */
  teamId?: number | undefined;
};

export type PageMeta = {
  nextCursor?: number;
  hasMore: boolean;
  totalCount: number;
  limit: number;
};

type ViewEnvelope = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  episodeId: string;
  revision: number;
  stateHash: string;
  season: number;
  phase: Phase;
};

export type OverviewView = ViewEnvelope & {
  view: "overview";
  status: EpisodeStatus;
  day?: number;
  employmentStatus?: EmploymentStatus;
  userTeam: TeamSummary;
  rosterCount: number;
  rosterExcerpt: PlayerSummary[];
  ownedPickCount: number;
  constraintsSatisfied: boolean;
  legalActionCategories: string[];
  nextDecision: string;
};

export type RosterView = ViewEnvelope & {
  view: "roster";
  /** The team this roster belongs to -- the user's own team unless GetStateInput.teamId selected another. */
  teamId: number;
  players: PlayerSummary[];
  page: PageMeta;
};

export type FinancesView = ViewEnvelope & {
  view: "finances";
  payroll: number;
  salaryCap: number;
  capSpace: number;
  luxuryTaxThreshold: number;
  hardCapActive: boolean;
  minContract: number;
  maxContract: number;
};

export type StandingsView = ViewEnvelope & {
  view: "standings";
  standings: TeamStanding[];
  page: PageMeta;
};

export type ScheduleView = ViewEnvelope & {
  view: "schedule";
  games: ScheduledGame[];
  page: PageMeta;
};

export type FreeAgentsView = ViewEnvelope & {
  view: "free_agents";
  players: PlayerSummary[];
  page: PageMeta;
};

export type DraftView = ViewEnvelope & {
  view: "draft";
  prospects: ProspectSummary[];
  prospectPage: PageMeta;
  /** All standard-league draft assets, sorted by season, round, and ID. */
  draftPicks: DraftPickSummary[];
  ownedPicks: DraftPickSummary[];
};

export type TransactionsView = ViewEnvelope & {
  view: "transactions";
  transactions: TransactionRecord[];
  page: PageMeta;
};

export type ObjectivesView = ViewEnvelope & {
  view: "objectives";
  objectives: ObjectiveStatus[];
};

export type ConstraintsView = ViewEnvelope & {
  view: "constraints";
  constraints: ConstraintStatus[];
};

export type TradingBlockView = ViewEnvelope &
  TradingBlockData & { view: "trading_block" };

export type TradeProposalsView = ViewEnvelope &
  TradeProposalsData & { view: "trade_proposals" };

export type LeagueStateView =
  | OverviewView
  | RosterView
  | FinancesView
  | StandingsView
  | ScheduleView
  | FreeAgentsView
  | DraftView
  | TransactionsView
  | ObjectivesView
  | ConstraintsView
  | TradingBlockView
  | TradeProposalsView;

// ---------------------------------------------------------------------------
// get_options
// ---------------------------------------------------------------------------

export type OptionsResult = {
  episodeId: string;
  revision: number;
  options: EngineOption[];
};

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type MutationContext = {
  expectedRevision: number;
  idempotencyKey: string;
};

export type MutationResult = {
  episodeId: string;
  previousRevision: number;
  revision: number;
  stateHash: string;
  appliedAction: Record<string, unknown>;
  events: EngineEvent[];
  warnings: string[];
  nextDecision: string;
  stateSummary: OverviewView;
};

export type IdempotencyRecord = {
  fingerprint: string;
  result: MutationResult;
};

export type TradeAsset =
  { type: "player"; pid: number } | { type: "draft_pick"; dpid: number };

export type TradeProposal = {
  otherTeamId: number;
  offered: TradeAsset[];
  requested: TradeAsset[];
};

export type TradeEvaluation = {
  legal: boolean;
  acceptedByOtherTeam: boolean | null;
  reasons: string[];
  payrollDelta: number;
  rosterSizeDelta: number;
  assetsExchanged: { offered: TradeAsset[]; requested: TradeAsset[] };
};

// ---------------------------------------------------------------------------
// Trading block / trade proposals (bbgm_get_state view="trading_block" /
// view="trade_proposals", bbgm_advertise_on_trading_block). Sourced from
// zengm's own tradingBlock/tradeProposals worker views rather than
// reimplemented trade logic -- see docs/INFORMATION_AUDIT.md and
// adapter.ts's getTradingBlock()/getTradeProposals(). Deliberately excludes
// zengm's internal `value` composite valuation, same as PlayerDetail.
// ---------------------------------------------------------------------------

/** A tradable asset as it appears in a trading-block advertisement or a
 * received offer -- richer than TradeAsset (which is only an identifier
 * used to construct a TradeProposal for bbgm_execute_trade). */
export type TradeOfferAsset =
  | {
      type: "player";
      pid: number;
      name?: string;
      age?: number;
      position?: string;
      overall?: number;
      potential?: number;
      /** Millions of dollars. */
      contractAmount?: number;
      contractExpires?: number;
      skills?: string[];
      untradable?: boolean;
    }
  | {
      type: "draft_pick";
      dpid: number;
      season?: number;
      round?: number;
      description?: string;
    };

/** One trade offer from another team, oriented the same way as
 * TradeProposal: `offered` is what the user would give up, `requested` is
 * what the user would receive -- so an offer here can be turned directly
 * into a bbgm_execute_trade call by dropping the display fields. Shared
 * shape for a trading-block-advertisement response and an AI-initiated
 * trade proposal. */
export type TradeOffer = {
  otherTeamId: number;
  /** "rebuilding" | "contending", when the engine exposes it. */
  strategy?: string;
  won?: number;
  lost?: number;
  /** Millions of dollars. */
  payroll?: number;
  offered: TradeOfferAsset[];
  requested: TradeOfferAsset[];
  /** Whether the other team's own trade-AI valuation currently favors this
   * offer. Present for trading-block offers (computed against the user's
   * advertised assets); AI-initiated trade proposals are already offers the
   * AI wants to make, so this is omitted there rather than implied true. */
  willing?: boolean;
};

export type TradingBlockData = {
  advertisedPids: number[];
  advertisedDpids: number[];
  offers: TradeOffer[];
  /** Roster players eligible to advertise (untradable ones are included but flagged). */
  tradableRoster: TradeOfferAsset[];
  /** Owned draft picks eligible to advertise. */
  tradablePicks: TradeOfferAsset[];
};

export type TradeProposalsData = {
  offers: TradeOffer[];
};

export type AdvertiseOnTradingBlockInput = {
  pids: number[];
  dpids: number[];
};

export type AdvanceInput = {
  target: AdvanceTarget;
  count?: number | undefined;
};

export type SetLineupInput = {
  order: number[];
};

export type ReleasePlayerInput = {
  pid: number;
};

export type NegotiateContractInput = {
  pid: number;
  amount: number;
  years: number;
};

export type SignFreeAgentInput = {
  pid: number;
  amount: number;
  years: number;
};

export type MakeDraftPickInput = {
  pid: number;
};

export type Checkpoint = {
  checkpointId: string;
  episodeId: string;
  revision: number;
  stateHash: string;
  createdAt: string;
};

export type EndEpisodeInput = {
  exportFinalSnapshot: boolean;
};

export type TerminalMetrics = {
  episodeId: string;
  seasonsCompleted: number;
  /** Record across all seasons represented by the episode, not just the current season. */
  finalRecord: { won: number; lost: number };
  hardConstraintViolations: number;
  transactionCount: number;
};

export type EndEpisodeResult = {
  episodeId: string;
  finalState: OverviewView;
  terminalMetrics: TerminalMetrics;
  snapshotCheckpointId?: string;
};
