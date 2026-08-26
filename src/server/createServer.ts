import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  leagueStateSchema,
  mutationResultSchema,
  tradeProposalSchema,
} from "../domain/schemas.js";
import type { EpisodeManager } from "../sessions/EpisodeManager.js";
import { failure, success } from "./results.js";

const annotations = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  mutate: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

const optionsOutputSchema = z
  .object({
    episodeId: episodeIdSchema,
    revision: z.number().int().nonnegative(),
    options: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

const tradeEvaluationSchema = z
  .object({
    legal: z.boolean(),
    acceptedByOtherTeam: z.boolean().nullable(),
    reasons: z.array(z.string()),
    payrollDelta: z.number(),
    rosterSizeDelta: z.number().int(),
  })
  .strict();

const checkpointSchema = z
  .object({
    checkpointId: z.string(),
    episodeId: episodeIdSchema,
    revision: z.number().int().nonnegative(),
    stateHash: z.string().length(64),
    createdAt: z.string(),
  })
  .strict();

export const createServer = (episodes: EpisodeManager): McpServer => {
  const server = new McpServer(
    { name: "bbgm-agent-mcp", version: "0.1.0" },
    {
      instructions:
        "Operate one Basketball GM episode by observing state, inspecting legal options, dry-running risky actions, mutating with the latest revision and a unique idempotency key, then observing again. Never guess entity IDs or reuse a mutation key for a different action.",
    },
  );

  server.registerTool(
    "bbgm_create_episode",
    {
      title: "Create Basketball GM Episode",
      description:
        "Create an isolated, seeded research episode and return its initial normalized state. Call this before all episode-scoped tools.",
      inputSchema: z
        .object({
          scenarioId: z.string().min(1).max(100).describe("Research scenario identifier"),
          seed: z.string().min(1).max(100).describe("Deterministic episode seed"),
          userTeamId: z.number().int().nonnegative().default(0).describe("Team controlled by the agent"),
          startingSeason: z.number().int().min(1900).max(2200).default(2026),
        })
        .strict(),
      outputSchema: leagueStateSchema,
      annotations: { ...annotations.mutate, destructiveHint: false },
    },
    async (input) => {
      try {
        return success(await episodes.create(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_get_state",
    {
      title: "Observe League State",
      description:
        "Read the current normalized state, constraints, revision, and state hash for an episode. This tool never advances or mutates the league.",
      inputSchema: z.object({ episodeId: episodeIdSchema }).strict(),
      outputSchema: leagueStateSchema,
      annotations: annotations.read,
    },
    async ({ episodeId }) => {
      try {
        return success(await episodes.getState(episodeId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_get_options",
    {
      title: "List Legal GM Options",
      description:
        "List legal action categories and bounded candidates for the current phase. Options are valid only for the returned revision.",
      inputSchema: z.object({ episodeId: episodeIdSchema }).strict(),
      outputSchema: optionsOutputSchema,
      annotations: annotations.read,
    },
    async ({ episodeId }) => {
      try {
        return success(await episodes.getOptions(episodeId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_evaluate_trade",
    {
      title: "Evaluate Trade",
      description:
        "Dry-run a proposed trade for legality, roster and payroll effects, and opponent acceptance when available. This never mutates league state.",
      inputSchema: z
        .object({ episodeId: episodeIdSchema, proposal: tradeProposalSchema })
        .strict(),
      outputSchema: tradeEvaluationSchema,
      annotations: annotations.read,
    },
    async ({ episodeId, proposal }) => {
      try {
        return success(await episodes.evaluateTrade(episodeId, proposal));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_execute_trade",
    {
      title: "Execute Trade",
      description:
        "Execute a previously inspected legal trade. Requires the current revision and a unique retry-safe idempotency key.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          proposal: tradeProposalSchema,
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: annotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, proposal }) => {
      try {
        return success(
          await episodes.executeTrade(episodeId, proposal, { expectedRevision, idempotencyKey }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_advance",
    {
      title: "Advance Simulation",
      description:
        "Advance a bounded amount of simulated time, stopping at the requested target or next decision point.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          target: z.enum(["next_game", "next_decision", "games"]),
          count: z.number().int().min(1).max(30).optional().describe("Required only for target=games"),
        })
        .strict()
        .refine(({ target, count }) => target !== "games" || count !== undefined, {
          message: "count is required when target is games",
          path: ["count"],
        }),
      outputSchema: mutationResultSchema,
      annotations: annotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, target, count }) => {
      try {
        return success(
          await episodes.advance(
            episodeId,
            count === undefined ? { target } : { target, count },
            { expectedRevision, idempotencyKey },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_checkpoint",
    {
      title: "Manage Checkpoints",
      description:
        "Create, list, or restore episode checkpoints. Restore is a mutation and requires revision and idempotency fields.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({ action: z.literal("create"), episodeId: episodeIdSchema }).strict(),
        z.object({ action: z.literal("list"), episodeId: episodeIdSchema }).strict(),
        z
          .object({
            action: z.literal("restore"),
            episodeId: episodeIdSchema,
            checkpointId: z.string().min(1).max(100),
            expectedRevision: expectedRevisionSchema,
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
      ]),
      outputSchema: z
        .object({
          action: z.enum(["create", "list", "restore"]),
          checkpoint: checkpointSchema.optional(),
          checkpoints: z.array(checkpointSchema).optional(),
          mutation: mutationResultSchema.optional(),
        })
        .strict(),
      annotations: annotations.mutate,
    },
    async (input) => {
      try {
        if (input.action === "create") {
          return success({ action: input.action, checkpoint: await episodes.createCheckpoint(input.episodeId) });
        }
        if (input.action === "list") {
          return success({ action: input.action, checkpoints: episodes.listCheckpoints(input.episodeId) });
        }
        return success({
          action: input.action,
          mutation: await episodes.restoreCheckpoint(input.episodeId, input.checkpointId, {
            expectedRevision: input.expectedRevision,
            idempotencyKey: input.idempotencyKey,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "bbgm_end_episode",
    {
      title: "End Episode",
      description:
        "Finalize an episode and close its simulation engine. The episode becomes permanently read-only.",
      inputSchema: z.object({ episodeId: episodeIdSchema }).strict(),
      outputSchema: leagueStateSchema,
      annotations: annotations.mutate,
    },
    async ({ episodeId }) => {
      try {
        return success(await episodes.end(episodeId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
};

