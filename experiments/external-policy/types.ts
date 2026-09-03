import * as z from "zod/v4";

import {
  advanceInputSchema,
  leagueStateViewSchema,
  makeDraftPickInputSchema,
  negotiateContractInputSchema,
  releasePlayerInputSchema,
  setLineupInputSchema,
  signFreeAgentInputSchema,
  tradeProposalSchema,
} from "../../src/domain/schemas.js";
import { GET_STATE_VIEWS } from "../../src/domain/types.js";
import type {
  Checkpoint,
  LeagueStateView,
  MutationResult,
  OptionsResult,
  TradeEvaluation,
} from "../../src/domain/types.js";

export const boundedObservationSchema = z
  .object({
    schemaVersion: z.literal("external-policy-observation.v2"),
    episodeId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    stateHash: z.string().min(1),
    season: z.number().int(),
    phase: z.string().min(1),
    nextDecision: z.string().max(256),
    legalActionCategories: z.array(z.string().max(64)).max(16),
    rosterCount: z.number().int().nonnegative(),
    ownedPickCount: z.number().int().nonnegative(),
    constraintsSatisfied: z.boolean(),
    allowedInformation: z.array(z.string().max(100)).max(64),
    allowedActions: z.array(z.string().max(100)).max(64),
    /** Only state views permitted by the scenario are included. */
    views: z
      .record(z.string(), leagueStateViewSchema)
      .superRefine((views, context) => {
        for (const [key, view] of Object.entries(views)) {
          if (!(GET_STATE_VIEWS as readonly string[]).includes(key)) {
            context.addIssue({
              code: "custom",
              path: [key],
              message: `unsupported state view ${key}`,
            });
          }
          if (view.view !== key) {
            context.addIssue({
              code: "custom",
              path: [key, "view"],
              message: `state view key ${key} does not match payload view ${view.view}`,
            });
          }
        }
      }),
    /** Bounded engine options are included only when the scenario permits them. */
    options: z
      .array(z.object({ type: z.string() }).catchall(z.unknown()))
      .max(50)
      .optional(),
  })
  .strict();

export type BoundedObservation = z.infer<typeof boundedObservationSchema>;

const getStateActionSchema = z
  .object({
    toolName: z.literal("bbgm_get_state"),
    arguments: z
      .object({
        view: z.enum(GET_STATE_VIEWS),
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(50).optional(),
        teamId: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

const getOptionsActionSchema = z
  .object({
    toolName: z.literal("bbgm_get_options"),
    arguments: z.object({}).strict(),
  })
  .strict();

const evaluateTradeActionSchema = z
  .object({
    toolName: z.literal("bbgm_evaluate_trade"),
    arguments: tradeProposalSchema,
  })
  .strict();

const executeTradeActionSchema = z
  .object({
    toolName: z.literal("bbgm_execute_trade"),
    arguments: tradeProposalSchema,
  })
  .strict();

const setLineupActionSchema = z
  .object({
    toolName: z.literal("bbgm_set_lineup"),
    arguments: setLineupInputSchema,
  })
  .strict();

const releasePlayerActionSchema = z
  .object({
    toolName: z.literal("bbgm_release_player"),
    arguments: releasePlayerInputSchema,
  })
  .strict();

const negotiateContractActionSchema = z
  .object({
    toolName: z.literal("bbgm_negotiate_contract"),
    arguments: negotiateContractInputSchema,
  })
  .strict();

const signFreeAgentActionSchema = z
  .object({
    toolName: z.literal("bbgm_sign_free_agent"),
    arguments: signFreeAgentInputSchema,
  })
  .strict();

const makeDraftPickActionSchema = z
  .object({
    toolName: z.literal("bbgm_make_draft_pick"),
    arguments: makeDraftPickInputSchema,
  })
  .strict();

const advanceActionSchema = z
  .object({
    toolName: z.literal("bbgm_advance"),
    arguments: advanceInputSchema,
  })
  .strict();

const createCheckpointActionSchema = z
  .object({
    toolName: z.literal("bbgm_create_checkpoint"),
    arguments: z.object({}).strict(),
  })
  .strict();

const listCheckpointsActionSchema = z
  .object({
    toolName: z.literal("bbgm_list_checkpoints"),
    arguments: z.object({}).strict(),
  })
  .strict();

const restoreCheckpointActionSchema = z
  .object({
    toolName: z.literal("bbgm_restore_checkpoint"),
    arguments: z.object({ checkpointId: z.string().min(1).max(100) }).strict(),
  })
  .strict();

/** Every action category permitted by a scenario has a typed external form. */
export const externalActionSchema = z.discriminatedUnion("toolName", [
  getStateActionSchema,
  getOptionsActionSchema,
  evaluateTradeActionSchema,
  executeTradeActionSchema,
  setLineupActionSchema,
  releasePlayerActionSchema,
  negotiateContractActionSchema,
  signFreeAgentActionSchema,
  makeDraftPickActionSchema,
  advanceActionSchema,
  createCheckpointActionSchema,
  listCheckpointsActionSchema,
  restoreCheckpointActionSchema,
]);

export type ExternalAction = z.infer<typeof externalActionSchema>;

export type ModelCallback = (observation: BoundedObservation) => unknown;

export type ActionEnvelope = {
  episodeId: string;
  expectedRevision: number;
  idempotencyKey: string;
  action: ExternalAction;
};

export type FailureRecord = {
  stage: "observation" | "callback" | "parse" | "policy" | "tool" | "audit";
  code: string;
  message: string;
  retryable: boolean;
};

export type ToolResultRecord =
  | {
      status: "ok";
      value:
        | Checkpoint
        | Checkpoint[]
        | LeagueStateView
        | MutationResult
        | OptionsResult
        | TradeEvaluation;
    }
  | { status: "error"; failure: FailureRecord };

export type StepRecord = {
  schemaVersion: "external-policy-step.v1";
  sequence: number;
  observedAt: string;
  observation: BoundedObservation | null;
  rawModelOutput: unknown;
  parsedAction: ExternalAction | null;
  actionEnvelope: ActionEnvelope | null;
  toolResult: ToolResultRecord | null;
  revision: { before: number | null; after: number | null };
  idempotency: {
    key: string;
    status: "issued" | "applied" | "not_applied" | "not_applicable";
  };
  failure: FailureRecord | null;
};

export type ExternalToolResult = NonNullable<StepRecord["toolResult"]>;

export type AuditSink = {
  append(record: StepRecord): Promise<void>;
};
