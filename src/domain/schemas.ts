import * as z from "zod/v4";

import {
  DEFAULT_ALLOWED_ACTIONS,
  DEFAULT_ALLOWED_INFORMATION,
  ADVANCE_TARGETS,
  GET_STATE_VIEWS,
  PHASES,
} from "./types.js";

// ---------------------------------------------------------------------------
// Primitive / shared field schemas
// ---------------------------------------------------------------------------

export const episodeIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .describe("Opaque episode identifier returned by bbgm_create_episode");

export const expectedRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .describe(
    "Current episode revision from the most recent state or mutation response. Stale values are rejected with REVISION_CONFLICT.",
  );

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .describe(
    "Unique retry-safe key for this specific mutation attempt. Reusing a key replays the original result instead of re-applying the action; never reuse a key for a logically different action.",
  );

export const mutationEnvelopeSchema = z.object({
  episodeId: episodeIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const pidSchema = z.number().int().nonnegative().describe("Player ID");
export const dpidSchema = z
  .number()
  .int()
  .nonnegative()
  .describe("Draft pick ID");
export const teamIdSchema = z.number().int().nonnegative().describe("Team ID");

export const phaseSchema = z.enum(PHASES);

// ---------------------------------------------------------------------------
// Domain object schemas
// ---------------------------------------------------------------------------

export const engineMetadataSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    commit: z.string().optional(),
  })
  .strict();

export const playerRoleSchema = z.enum([
  "starter",
  "rotation",
  "bench",
  "inactive",
]);

export const playerSummarySchema = z
  .object({
    pid: pidSchema,
    name: z.string(),
    age: z.number().int(),
    position: z.string(),
    overall: z.number(),
    potential: z.number(),
    contractAmount: z.number(),
    contractExpires: z.number().int(),
    injuryGamesRemaining: z.number().int().nonnegative(),
    role: playerRoleSchema,
    rosterOrder: z.number().int().nonnegative(),
    overallChange: z.number().optional(),
    potentialChange: z.number().optional(),
    skills: z.array(z.string()).optional(),
    untradable: z.boolean().optional(),
    willingToNegotiate: z.boolean().optional(),
    probWilling: z.number().optional(),
    askingAmount: z.number().optional(),
    yearsWithTeam: z.number().optional(),
    gamesPlayed: z.number().optional(),
    minutesPerGame: z.number().optional(),
    pointsPerGame: z.number().optional(),
    reboundsPerGame: z.number().optional(),
    assistsPerGame: z.number().optional(),
    per: z.number().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Player detail (bbgm_get_player)
// ---------------------------------------------------------------------------

export const playerRatingsSeasonSchema = z
  .object({
    season: z.number().int(),
    teamId: teamIdSchema.optional(),
    age: z.number().int().optional(),
    overall: z.number().optional(),
    potential: z.number().optional(),
    hgt: z.number().optional(),
    str: z.number().optional(),
    spd: z.number().optional(),
    jmp: z.number().optional(),
    endu: z.number().optional(),
    ins: z.number().optional(),
    dnk: z.number().optional(),
    ft: z.number().optional(),
    fg: z.number().optional(),
    tp: z.number().optional(),
    oiq: z.number().optional(),
    diq: z.number().optional(),
    drb: z.number().optional(),
    pss: z.number().optional(),
    reb: z.number().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

export const playerStatsSeasonSchema = z
  .object({
    season: z.number().int(),
    teamId: teamIdSchema.optional(),
    playoffs: z.boolean(),
    gamesPlayed: z.number().optional(),
    minutesPerGame: z.number().optional(),
    pointsPerGame: z.number().optional(),
    reboundsPerGame: z.number().optional(),
    assistsPerGame: z.number().optional(),
    stealsPerGame: z.number().optional(),
    blocksPerGame: z.number().optional(),
    turnoversPerGame: z.number().optional(),
    fieldGoalPct: z.number().optional(),
    threePointPct: z.number().optional(),
    freeThrowPct: z.number().optional(),
    per: z.number().optional(),
    offensiveWinShares: z.number().optional(),
    defensiveWinShares: z.number().optional(),
    winShares: z.number().optional(),
    winSharesPer48: z.number().optional(),
    offensiveBPM: z.number().optional(),
    defensiveBPM: z.number().optional(),
    bpm: z.number().optional(),
    vorp: z.number().optional(),
    trueShootingPct: z.number().optional(),
    usagePct: z.number().optional(),
  })
  .strict();

export const playerContractYearSchema = z
  .object({
    season: z.number().int(),
    amount: z.number(),
    type: z.enum(["past", "current", "future"]),
  })
  .strict();

export const playerAwardSchema = z
  .object({
    season: z.number().int(),
    type: z.string(),
  })
  .strict();

export const playerInjuryHistoryEntrySchema = z
  .object({
    season: z.number().int().optional(),
    type: z.string(),
    games: z.number().optional(),
  })
  .strict();

export const playerDraftInfoSchema = z
  .object({
    year: z.number().int().optional(),
    round: z.number().int().optional(),
    pick: z.number().int().optional(),
    originalTeamId: teamIdSchema.optional(),
  })
  .strict();

export const playerDetailSchema = z
  .object({
    pid: pidSchema,
    name: z.string().optional(),
    age: z.number().int().optional(),
    position: z.string().optional(),
    teamId: teamIdSchema.optional(),
    ratingsHistory: z.array(playerRatingsSeasonSchema),
    statsHistory: z.array(playerStatsSeasonSchema),
    contractAmount: z.number().optional(),
    contractExpires: z.number().int().optional(),
    contractSchedule: z.array(playerContractYearSchema),
    awards: z.array(playerAwardSchema),
    draft: playerDraftInfoSchema.optional(),
    currentInjury: z
      .object({ type: z.string(), gamesRemaining: z.number().int() })
      .strict()
      .optional(),
    injuryHistory: z.array(playerInjuryHistoryEntrySchema),
  })
  .strict();

export const getPlayerInputSchema = z
  .object({
    episodeId: episodeIdSchema,
    pid: pidSchema,
  })
  .strict();

export const getPlayerResultSchema = z
  .object({
    episodeId: episodeIdSchema,
    revision: z.number().int().nonnegative(),
    player: playerDetailSchema,
  })
  .strict();

export const prospectSummarySchema = z
  .object({
    pid: pidSchema,
    name: z.string(),
    age: z.number().int(),
    position: z.string(),
    scoutedOverall: z.number(),
    scoutedPotential: z.number(),
    draftYear: z.number().int(),
  })
  .strict();

export const draftPickSummarySchema = z
  .object({
    dpid: dpidSchema,
    season: z.number().int(),
    round: z.number().int().positive(),
    originalTeamId: teamIdSchema,
    currentTeamId: teamIdSchema,
    protection: z.string().optional(),
  })
  .strict();

export const teamSummarySchema = z
  .object({
    tid: teamIdSchema,
    name: z.string(),
    abbrev: z.string(),
    won: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    conference: z.string(),
    division: z.string(),
    standing: z.number().int(),
    payroll: z.number(),
    salaryCap: z.number(),
    capSpace: z.number(),
    luxuryTaxThreshold: z.number(),
    minContract: z.number(),
    maxContract: z.number(),
    hardCapActive: z.boolean(),
  })
  .strict();

export const teamStandingSchema = z
  .object({
    tid: teamIdSchema,
    name: z.string(),
    abbrev: z.string(),
    won: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    conference: z.string(),
    division: z.string(),
    rank: z.number().int(),
    gamesBehind: z.number(),
  })
  .strict();

export const scheduledGameSchema = z
  .object({
    gid: z.number().int(),
    season: z.number().int(),
    day: z.number().int(),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    played: z.boolean(),
    homeScore: z.number().int().optional(),
    awayScore: z.number().int().optional(),
  })
  .strict();

export const transactionRecordSchema = z
  .object({
    transactionId: z.number().int(),
    season: z.number().int(),
    day: z.number().int(),
    type: z.enum(["trade", "release", "sign", "draft", "contract_extension"]),
    description: z.string(),
    teamIds: z.array(teamIdSchema),
  })
  .strict();

export const constraintStatusSchema = z
  .object({
    code: z.string(),
    kind: z.enum(["hard", "soft"]),
    satisfied: z.boolean(),
    message: z.string(),
  })
  .strict();

export const objectiveStatusSchema = z
  .object({
    code: z.string(),
    description: z.string(),
    weight: z.number(),
    currentValue: z.number(),
    targetValue: z.number().optional(),
  })
  .strict();

export const constraintDefinitionSchema = z
  .object({
    code: z.string().min(1).max(60),
    description: z.string().min(1).max(400),
  })
  .strict();
export const objectiveDefinitionSchema = z
  .object({
    code: z.string().min(1).max(60),
    description: z.string().min(1).max(400),
    weight: z.number(),
    targetValue: z.number().optional(),
  })
  .strict();

export const scenarioConstraintSpecSchema = z
  .object({
    hard: z.array(constraintDefinitionSchema).max(50).default([]),
    soft: z.array(objectiveDefinitionSchema).max(50).default([]),
  })
  .strict();

export const scenarioPolicySchema = z
  .object({
    allowedInformation: z
      .array(z.string().min(1).max(100))
      .default([...DEFAULT_ALLOWED_INFORMATION])
      .describe("State channels the agent is permitted to observe"),
    allowedActions: z
      .array(z.string().min(1).max(100))
      .default([...DEFAULT_ALLOWED_ACTIONS])
      .describe("Tool action categories the agent is permitted to use"),
    allowedAdvanceTargets: z
      .enum(ADVANCE_TARGETS)
      .array()
      .optional()
      .describe(
        "Specific advance targets permitted to this scenario; use a narrow milestone list to prevent unrestricted time skipping",
      ),
    maxSteps: z
      .number()
      .int()
      .nonnegative()
      .max(5000)
      .optional()
      .describe("Maximum number of agent action attempts"),
    horizonSeasons: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe("Maximum seasons from the episode's starting season"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const pageMetaSchema = z
  .object({
    nextCursor: z.number().int().nonnegative().optional(),
    hasMore: z.boolean(),
    totalCount: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .strict();

export const paginationInputSchema = z.object({
  cursor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Opaque pagination cursor from a previous page's nextCursor"),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum items to return; defaults to a bounded server value"),
});

// ---------------------------------------------------------------------------
// get_state views
// ---------------------------------------------------------------------------

const viewEnvelopeSchema = {
  schemaVersion: z.literal("1"),
  episodeId: episodeIdSchema,
  revision: z.number().int().nonnegative(),
  stateHash: z.string().length(64),
  season: z.number().int(),
  phase: phaseSchema,
};

export const overviewViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("overview"),
    status: z.enum(["active", "ended", "quarantined"]),
    day: z.number().int().optional(),
    employmentStatus: z.enum(["employed", "fired", "unknown"]).optional(),
    userTeam: teamSummarySchema,
    rosterCount: z.number().int().nonnegative(),
    rosterExcerpt: z.array(playerSummarySchema),
    ownedPickCount: z.number().int().nonnegative(),
    constraintsSatisfied: z.boolean(),
    legalActionCategories: z.array(z.string()),
    nextDecision: z.string(),
  })
  .strict();

export const rosterViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("roster"),
    teamId: teamIdSchema.describe("The team this roster belongs to"),
    players: z.array(playerSummarySchema),
    page: pageMetaSchema,
  })
  .strict();

export const financesViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("finances"),
    payroll: z.number(),
    salaryCap: z.number(),
    capSpace: z.number(),
    luxuryTaxThreshold: z.number(),
    minContract: z.number(),
    maxContract: z.number(),
    hardCapActive: z.boolean(),
  })
  .strict();

export const standingsViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("standings"),
    standings: z.array(teamStandingSchema),
    page: pageMetaSchema,
  })
  .strict();

export const scheduleViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("schedule"),
    games: z.array(scheduledGameSchema),
    page: pageMetaSchema,
  })
  .strict();

export const freeAgentsViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("free_agents"),
    players: z.array(playerSummarySchema),
    page: pageMetaSchema,
  })
  .strict();

export const draftViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("draft"),
    prospects: z.array(prospectSummarySchema),
    prospectPage: pageMetaSchema,
    draftPicks: z.array(draftPickSummarySchema),
    ownedPicks: z.array(draftPickSummarySchema),
  })
  .strict();

export const transactionsViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("transactions"),
    transactions: z.array(transactionRecordSchema),
    page: pageMetaSchema,
  })
  .strict();

export const objectivesViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("objectives"),
    objectives: z.array(objectiveStatusSchema),
  })
  .strict();

export const constraintsViewSchema = z
  .object({
    ...viewEnvelopeSchema,
    view: z.literal("constraints"),
    constraints: z.array(constraintStatusSchema),
  })
  .strict();

export const leagueStateViewSchema = z.discriminatedUnion("view", [
  overviewViewSchema,
  rosterViewSchema,
  financesViewSchema,
  standingsViewSchema,
  scheduleViewSchema,
  freeAgentsViewSchema,
  draftViewSchema,
  transactionsViewSchema,
  objectivesViewSchema,
  constraintsViewSchema,
]);

export const getStateInputSchema = z
  .object({
    episodeId: episodeIdSchema,
    view: z
      .enum(GET_STATE_VIEWS)
      .describe("Bounded slice of league state to return"),
    cursor: paginationInputSchema.shape.cursor,
    limit: paginationInputSchema.shape.limit,
    teamId: teamIdSchema
      .optional()
      .describe(
        "Only used when view=\"roster\": read this team's public roster instead of the user's own. Omit for the user's own roster.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// get_options
// ---------------------------------------------------------------------------

export const optionsResultSchema = z
  .object({
    episodeId: episodeIdSchema,
    revision: z.number().int().nonnegative(),
    options: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
  })
  .strict();

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export const tradeAssetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("player"), pid: pidSchema }).strict(),
  z.object({ type: z.literal("draft_pick"), dpid: dpidSchema }).strict(),
]);

export const tradeProposalSchema = z
  .object({
    otherTeamId: teamIdSchema.describe("Trade partner team ID"),
    offered: z
      .array(tradeAssetSchema)
      .max(20)
      .describe("Assets sent by the user team"),
    requested: z
      .array(tradeAssetSchema)
      .max(20)
      .describe("Assets requested from the other team"),
  })
  .strict();

export const tradeEvaluationSchema = z
  .object({
    legal: z.boolean(),
    acceptedByOtherTeam: z.boolean().nullable(),
    reasons: z.array(z.string()),
    payrollDelta: z.number(),
    rosterSizeDelta: z.number().int(),
    assetsExchanged: z
      .object({
        offered: z.array(tradeAssetSchema),
        requested: z.array(tradeAssetSchema),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Roster / contract mutations
// ---------------------------------------------------------------------------

export const setLineupInputSchema = z
  .object({
    order: z
      .array(pidSchema)
      .min(1)
      .max(20)
      .describe(
        "Roster player IDs in depth-chart priority order, most-preferred first",
      ),
  })
  .strict();

export const releasePlayerInputSchema = z.object({ pid: pidSchema }).strict();

export const contractTermsSchema = z.object({
  amount: z
    .number()
    .positive()
    .max(500)
    .describe("Annual salary in millions of dollars"),
  years: z.number().int().min(1).max(7),
});

export const negotiateContractInputSchema = z
  .object({ pid: pidSchema, ...contractTermsSchema.shape })
  .strict();
export const signFreeAgentInputSchema = z
  .object({ pid: pidSchema, ...contractTermsSchema.shape })
  .strict();
export const makeDraftPickInputSchema = z
  .object({
    pid: pidSchema.describe("Prospect ID to select with the current pick"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

export const advanceTargetSchema = z.enum([
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
]);

export const advanceCountSchema = z
  .number()
  .int()
  .min(1)
  .max(30)
  .optional()
  .describe("Required and bounded to 30 when target is days or games");

/** Pre-refine object schema; tool files read `.shape` off this for their own inputSchema composition. */
export const advanceInputObjectSchema = z
  .object({
    target: advanceTargetSchema,
    count: advanceCountSchema,
  })
  .strict();

export const advanceInputSchema = advanceInputObjectSchema.refine(
  (value) =>
    value.target === "days" || value.target === "games"
      ? value.count !== undefined
      : true,
  {
    message: "count is required when target is days or games",
    path: ["count"],
  },
);

// ---------------------------------------------------------------------------
// Mutation result / checkpoint
// ---------------------------------------------------------------------------

export const mutationResultSchema = z
  .object({
    episodeId: episodeIdSchema,
    previousRevision: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    stateHash: z.string().length(64),
    appliedAction: z.record(z.string(), z.unknown()),
    events: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
    warnings: z.array(z.string()),
    nextDecision: z.string(),
    stateSummary: overviewViewSchema,
  })
  .strict();

export const idempotencyRecordSchema = z
  .object({
    fingerprint: z.string().length(64),
    result: mutationResultSchema,
  })
  .strict();

export const checkpointSchema = z
  .object({
    checkpointId: z.string(),
    episodeId: episodeIdSchema,
    revision: z.number().int().nonnegative(),
    stateHash: z.string().length(64),
    createdAt: z.string(),
  })
  .strict();

export const createCheckpointInputSchema = z
  .object({ episodeId: episodeIdSchema })
  .strict();

export const listCheckpointsInputSchema = z
  .object({ episodeId: episodeIdSchema })
  .strict();

export const restoreCheckpointInputSchema = z
  .object({
    episodeId: episodeIdSchema,
    checkpointId: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "Opaque checkpoint ID from bbgm_create_checkpoint or bbgm_list_checkpoints",
      ),
    expectedRevision: expectedRevisionSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const createCheckpointResultSchema = z
  .object({ checkpoint: checkpointSchema })
  .strict();

export const listCheckpointsResultSchema = z
  .object({ checkpoints: z.array(checkpointSchema) })
  .strict();

export const restoreCheckpointResultSchema = z
  .object({ mutation: mutationResultSchema })
  .strict();

// ---------------------------------------------------------------------------
// create / end episode
// ---------------------------------------------------------------------------

export const createEpisodeInputSchema = z
  .object({
    scenarioId: z
      .string()
      .min(1)
      .max(100)
      .describe("Research scenario identifier; grouped in trajectory logs"),
    seed: z.string().min(1).max(100).describe("Deterministic episode seed"),
    userTeamId: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Team controlled by the agent"),
    startingSeason: z.number().int().min(1900).max(2200).default(2026),
    constraints: scenarioConstraintSpecSchema.optional(),
    scenarioPolicy: scenarioPolicySchema.optional(),
    initialSnapshot: z
      .unknown()
      .optional()
      .describe("Evaluator-only starting engine snapshot"),
  })
  .strict();

export const endEpisodeInputSchema = z
  .object({
    episodeId: episodeIdSchema,
    exportFinalSnapshot: z
      .boolean()
      .default(true)
      .describe("Whether to persist a final checkpoint before closing"),
  })
  .strict();

export const terminalMetricsSchema = z
  .object({
    episodeId: episodeIdSchema,
    seasonsCompleted: z.number().int().nonnegative(),
    finalRecord: z
      .object({
        won: z.number().int().nonnegative(),
        lost: z.number().int().nonnegative(),
      })
      .strict(),
    hardConstraintViolations: z.number().int().nonnegative(),
    transactionCount: z.number().int().nonnegative(),
  })
  .strict();

export const endEpisodeResultSchema = z
  .object({
    episodeId: episodeIdSchema,
    finalState: overviewViewSchema,
    terminalMetrics: terminalMetricsSchema,
    snapshotCheckpointId: z.string().optional(),
  })
  .strict();
