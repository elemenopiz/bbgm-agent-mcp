export const STATE_SCHEMA_VERSION = "1" as const;

export type EpisodeStatus = "active" | "ended";

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
  round: 1 | 2;
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
  season: number;
  phase: Phase;
  day?: number;
  userTeam: TeamSummary;
  roster: PlayerSummary[];
  freeAgents: PlayerSummary[];
  draftProspects: ProspectSummary[];
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
  | ConstraintsView;

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

export type AdvanceTarget =
  "next_game" | "next_decision" | "days" | "games" | "phase" | "season_end";

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
