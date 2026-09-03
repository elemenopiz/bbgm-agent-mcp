import type {
  ConstraintStatus,
  ConstraintsView,
  DraftView,
  EngineRawState,
  EpisodeStatus,
  FinancesView,
  FreeAgentsView,
  GetStateViewName,
  LeagueStateView,
  ObjectiveStatus,
  ObjectivesView,
  OverviewView,
  PageMeta,
  PlayerSummary,
  RosterView,
  ScenarioConstraintSpec,
  ScheduleView,
  StandingsView,
  TransactionsView,
} from "./types.js";
import { STATE_SCHEMA_VERSION } from "./types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const paginate = <T>(
  items: T[],
  cursor: number | undefined,
  limit: number | undefined,
): { page: T[]; meta: PageMeta } => {
  const boundedLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const start = Math.min(Math.max(cursor ?? 0, 0), items.length);
  const page = items.slice(start, start + boundedLimit);
  const nextIndex = start + page.length;
  const hasMore = nextIndex < items.length;
  return {
    page,
    meta: {
      totalCount: items.length,
      limit: boundedLimit,
      hasMore,
      ...(hasMore ? { nextCursor: nextIndex } : {}),
    },
  };
};

const ROSTER_EXCERPT_SIZE = 5;

type EnvelopeInput = {
  episodeId: string;
  revision: number;
  stateHash: string;
  state: EngineRawState;
};

export const SUPPORTED_OBJECTIVE_CODES = [
  "MAXIMIZE_WINS",
  "MAXIMIZE_CAP_SPACE",
  "MINIMIZE_ROSTER_CHURN",
  "PRESERVE_DRAFT_CAPITAL",
] as const;

export const isSupportedObjectiveCode = (code: string): boolean =>
  (SUPPORTED_OBJECTIVE_CODES as readonly string[]).includes(code);

/** Well-known evaluators for scenario-declared soft objectives. */
const evaluateObjectiveValue = (
  code: string,
  state: EngineRawState,
): number => {
  switch (code) {
    case "MAXIMIZE_WINS":
      return state.userTeam.won;
    case "MAXIMIZE_CAP_SPACE":
      return state.userTeam.capSpace;
    case "MINIMIZE_ROSTER_CHURN":
      return -state.recentTransactions.length;
    case "PRESERVE_DRAFT_CAPITAL":
      return state.ownedPicks.length;
    default:
      return 0;
  }
};

export const buildObjectivesFromSpec = (
  spec: ScenarioConstraintSpec,
  state: EngineRawState,
): ObjectiveStatus[] =>
  spec.soft.map((definition) => ({
    code: definition.code,
    description: definition.description,
    weight: definition.weight,
    currentValue: evaluateObjectiveValue(definition.code, state),
    ...(definition.targetValue === undefined
      ? {}
      : { targetValue: definition.targetValue }),
  }));

export const buildOverviewView = (
  input: EnvelopeInput,
  status: EpisodeStatus,
  constraints: ConstraintStatus[],
  allowedActions?: readonly string[],
  allowedInformation?: readonly string[],
): OverviewView => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  view: "overview",
  episodeId: input.episodeId,
  revision: input.revision,
  stateHash: input.stateHash,
  season: input.state.season,
  phase: input.state.phase,
  status,
  ...(input.state.day === undefined ? {} : { day: input.state.day }),
  ...(input.state.employmentStatus === undefined
    ? {}
    : { employmentStatus: input.state.employmentStatus }),
  userTeam: input.state.userTeam,
  rosterCount: input.state.roster.length,
  rosterExcerpt: [...input.state.roster]
    .sort((a, b) => b.overall - a.overall)
    .slice(0, ROSTER_EXCERPT_SIZE),
  ownedPickCount: input.state.ownedPicks.length,
  constraintsSatisfied: constraints.every((c) => c.satisfied),
  legalActionCategories: input.state.legalActionCategories.filter((action) => {
    if (allowedActions === undefined || allowedInformation === undefined)
      return true;
    if (action === "get_state") return allowedInformation.length > 0;
    if (action === "get_options") return allowedInformation.includes("options");
    if (action === "checkpoint")
      return [
        "create_checkpoint",
        "list_checkpoints",
        "restore_checkpoint",
      ].some((candidate) => allowedActions.includes(candidate));
    return allowedActions.includes(action);
  }),
  nextDecision: input.state.nextDecision,
});

const buildRosterView = (
  input: EnvelopeInput,
  cursor: number | undefined,
  limit: number | undefined,
  rosterOverride: { teamId: number; players: PlayerSummary[] } | undefined,
): RosterView => {
  const teamId = rosterOverride?.teamId ?? input.state.userTeam.tid;
  const players = rosterOverride?.players ?? input.state.roster;
  const { page, meta } = paginate(players, cursor, limit);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    view: "roster",
    episodeId: input.episodeId,
    revision: input.revision,
    stateHash: input.stateHash,
    season: input.state.season,
    phase: input.state.phase,
    teamId,
    players: page,
    page: meta,
  };
};

const buildFinancesView = (input: EnvelopeInput): FinancesView => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  view: "finances",
  episodeId: input.episodeId,
  revision: input.revision,
  stateHash: input.stateHash,
  season: input.state.season,
  phase: input.state.phase,
  payroll: input.state.userTeam.payroll,
  salaryCap: input.state.userTeam.salaryCap,
  capSpace: input.state.userTeam.capSpace,
  luxuryTaxThreshold: input.state.userTeam.luxuryTaxThreshold,
  hardCapActive: input.state.userTeam.hardCapActive,
  minContract: input.state.userTeam.minContract,
  maxContract: input.state.userTeam.maxContract,
});

const buildStandingsView = (
  input: EnvelopeInput,
  cursor?: number,
  limit?: number,
): StandingsView => {
  const { page, meta } = paginate(input.state.standings, cursor, limit);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    view: "standings",
    episodeId: input.episodeId,
    revision: input.revision,
    stateHash: input.stateHash,
    season: input.state.season,
    phase: input.state.phase,
    standings: page,
    page: meta,
  };
};

const buildScheduleView = (
  input: EnvelopeInput,
  cursor?: number,
  limit?: number,
): ScheduleView => {
  const { page, meta } = paginate(input.state.schedule, cursor, limit);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    view: "schedule",
    episodeId: input.episodeId,
    revision: input.revision,
    stateHash: input.stateHash,
    season: input.state.season,
    phase: input.state.phase,
    games: page,
    page: meta,
  };
};

const buildFreeAgentsView = (
  input: EnvelopeInput,
  cursor?: number,
  limit?: number,
): FreeAgentsView => {
  const { page, meta } = paginate(input.state.freeAgents, cursor, limit);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    view: "free_agents",
    episodeId: input.episodeId,
    revision: input.revision,
    stateHash: input.stateHash,
    season: input.state.season,
    phase: input.state.phase,
    players: page,
    page: meta,
  };
};

const buildDraftView = (
  input: EnvelopeInput,
  cursor?: number,
  limit?: number,
): DraftView => {
  const { page, meta } = paginate(input.state.draftProspects, cursor, limit);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    view: "draft",
    episodeId: input.episodeId,
    revision: input.revision,
    stateHash: input.stateHash,
    season: input.state.season,
    phase: input.state.phase,
    prospects: page,
    prospectPage: meta,
    draftPicks: [...input.state.draftPicks].sort(
      (a, b) => a.season - b.season || a.round - b.round || a.dpid - b.dpid,
    ),
    ownedPicks: input.state.ownedPicks,
  };
};

const buildTransactionsView = (
  input: EnvelopeInput,
  cursor?: number,
  limit?: number,
): TransactionsView => {
  const { page, meta } = paginate(
    input.state.recentTransactions,
    cursor,
    limit,
  );
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    view: "transactions",
    episodeId: input.episodeId,
    revision: input.revision,
    stateHash: input.stateHash,
    season: input.state.season,
    phase: input.state.phase,
    transactions: page,
    page: meta,
  };
};

const buildObjectivesView = (
  input: EnvelopeInput,
  objectives: ObjectiveStatus[],
): ObjectivesView => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  view: "objectives",
  episodeId: input.episodeId,
  revision: input.revision,
  stateHash: input.stateHash,
  season: input.state.season,
  phase: input.state.phase,
  objectives,
});

const buildConstraintsView = (
  input: EnvelopeInput,
  constraints: ConstraintStatus[],
): ConstraintsView => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  view: "constraints",
  episodeId: input.episodeId,
  revision: input.revision,
  stateHash: input.stateHash,
  season: input.state.season,
  phase: input.state.phase,
  constraints,
});

export type ViewContext = {
  status: EpisodeStatus;
  constraints: ConstraintStatus[];
  objectives: ObjectiveStatus[];
  allowedActions?: readonly string[];
  allowedInformation?: readonly string[];
  cursor?: number;
  limit?: number;
  /** Set when view="roster" is reading a team other than the user's own -- see DomainService.getState. */
  rosterOverride?: { teamId: number; players: PlayerSummary[] };
};

export const buildView = (
  view: GetStateViewName,
  input: EnvelopeInput,
  context: ViewContext,
): LeagueStateView => {
  switch (view) {
    case "overview":
      return buildOverviewView(
        input,
        context.status,
        context.constraints,
        context.allowedActions,
        context.allowedInformation,
      );
    case "roster":
      return buildRosterView(
        input,
        context.cursor,
        context.limit,
        context.rosterOverride,
      );
    case "finances":
      return buildFinancesView(input);
    case "standings":
      return buildStandingsView(input, context.cursor, context.limit);
    case "schedule":
      return buildScheduleView(input, context.cursor, context.limit);
    case "free_agents":
      return buildFreeAgentsView(input, context.cursor, context.limit);
    case "draft":
      return buildDraftView(input, context.cursor, context.limit);
    case "transactions":
      return buildTransactionsView(input, context.cursor, context.limit);
    case "objectives":
      return buildObjectivesView(input, context.objectives);
    case "constraints":
      return buildConstraintsView(input, context.constraints);
  }
};
