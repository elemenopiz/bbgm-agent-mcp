import { readFile } from "node:fs/promises";

import * as z from "zod/v4";

import {
  constraintDefinitionSchema,
  objectiveDefinitionSchema,
  advanceTargetSchema,
} from "../domain/schemas.js";
import {
  DEFAULT_REWARD_WEIGHTS,
  objectiveSeparationSchema,
  rewardConfigSchema,
} from "./objectives.js";

export const scenarioManifestSchema = z
  .object({
    scenarioId: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    split: z
      .object({
        role: z.enum(["pilot", "development", "held_out"]),
        parentScenarioId: z.string().min(1).max(100).optional(),
      })
      .strict()
      .optional()
      .describe(
        "Declared evaluation split; held-out seeds are never for policy selection",
      ),
    seedSet: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Fixed seeds to evaluate this scenario over, for cross-agent comparability",
      ),
    userTeamId: z.number().int().nonnegative().default(0),
    startingSeason: z.number().int().min(1900).max(2200).default(2026),
    initialSnapshotPath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Optional manifest-relative JSON engine snapshot for controlled starts",
      ),
    horizonSeasons: z.number().int().min(1).max(20),
    hardConstraints: z.array(constraintDefinitionSchema).default([]),
    softObjectives: z.array(objectiveDefinitionSchema).default([]),
    allowedInformation: z
      .array(z.string())
      .default([
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
      ])
      .describe("get_state views the evaluated policy/agent may read"),
    allowedActions: z
      .array(z.string())
      .default([
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
      ])
      .describe("Tool-shaped actions the evaluated policy/agent may take"),
    allowedAdvanceTargets: advanceTargetSchema
      .array()
      .optional()
      .describe(
        "Specific advance targets permitted to the evaluated policy; prefer milestone targets over open-ended time stepping",
      ),
    maxSteps: z
      .number()
      .int()
      .nonnegative()
      .max(5000)
      .describe(
        "Hard cap on tool-call-equivalent steps before the run is truncated",
      ),
    reward: rewardConfigSchema.default({
      mode: "scalar",
      weights: DEFAULT_REWARD_WEIGHTS,
    }),
    /** Visible proxy vs hidden intended objective. Optional so existing
     * benchmark manifests keep their single-reward semantics; when present,
     * the evaluator scores every run against both. The hidden config is never
     * served to the policy -- only `softObjectives` reaches the agent. */
    objectiveSeparation: objectiveSeparationSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.seedSet).size !== manifest.seedSet.length) {
      context.addIssue({
        code: "custom",
        path: ["seedSet"],
        message: "seedSet must not contain duplicates",
      });
    }
  });

export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;

export const loadScenarioManifest = async (
  path: string,
): Promise<ScenarioManifest> => {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return scenarioManifestSchema.parse(raw);
};
