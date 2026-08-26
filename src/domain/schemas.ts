import * as z from "zod/v4";

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
  .describe("Current episode revision from the most recent state response");

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .describe("Unique retry-safe key for this mutation");

export const tradeAssetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("player"), pid: z.number().int().nonnegative() }).strict(),
  z
    .object({ type: z.literal("draft_pick"), dpid: z.number().int().nonnegative() })
    .strict(),
]);

export const tradeProposalSchema = z
  .object({
    otherTeamId: z.number().int().nonnegative().describe("Trade partner team ID"),
    offered: z.array(tradeAssetSchema).max(20).describe("Assets sent by the user team"),
    requested: z.array(tradeAssetSchema).max(20).describe("Assets requested from the other team"),
  })
  .strict();

export const engineMetadataSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    commit: z.string().optional(),
  })
  .strict();

export const playerSummarySchema = z
  .object({
    pid: z.number().int(),
    name: z.string(),
    age: z.number().int(),
    position: z.string(),
    overall: z.number(),
    potential: z.number(),
    contractAmount: z.number(),
    contractExpires: z.number().int(),
    injuryGamesRemaining: z.number().int().nonnegative(),
  })
  .strict();

export const constraintSchema = z
  .object({ code: z.string(), satisfied: z.boolean(), message: z.string() })
  .strict();

export const leagueStateSchema = z
  .object({
    schemaVersion: z.literal("1"),
    episodeId: episodeIdSchema,
    scenarioId: z.string(),
    seed: z.string(),
    engine: engineMetadataSchema,
    status: z.enum(["active", "ended"]),
    revision: z.number().int().nonnegative(),
    stateHash: z.string().length(64),
    season: z.number().int(),
    phase: z.string(),
    userTeam: z
      .object({
        tid: z.number().int(),
        name: z.string(),
        won: z.number().int().nonnegative(),
        lost: z.number().int().nonnegative(),
        payroll: z.number(),
        salaryCap: z.number(),
        capSpace: z.number(),
      })
      .strict(),
    roster: z.array(playerSummarySchema),
    constraints: z.array(constraintSchema),
    legalActionCategories: z.array(z.string()),
    nextDecision: z.string(),
  })
  .strict();

export const mutationResultSchema = z
  .object({
    episodeId: episodeIdSchema,
    previousRevision: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    stateHash: z.string().length(64),
    appliedAction: z.record(z.string(), z.unknown()),
    events: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
    nextDecision: z.string(),
  })
  .strict();

