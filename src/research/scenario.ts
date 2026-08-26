import { readFile } from "node:fs/promises";

import * as z from "zod/v4";

import {
  constraintDefinitionSchema,
  objectiveDefinitionSchema,
} from "../domain/schemas.js";

export const scenarioManifestSchema = z
  .object({
    scenarioId: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    seedSet: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Fixed seeds to evaluate this scenario over, for cross-agent comparability",
      ),
    userTeamId: z.number().int().nonnegative().default(0),
    startingSeason: z.number().int().min(1900).max(2200).default(2026),
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
        "checkpoint",
      ])
      .describe("Tool-shaped actions the evaluated policy/agent may take"),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .describe(
        "Hard cap on tool-call-equivalent steps before the run is truncated",
      ),
  })
  .strict();

export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;

export const loadScenarioManifest = async (
  path: string,
): Promise<ScenarioManifest> => {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return scenarioManifestSchema.parse(raw);
};
