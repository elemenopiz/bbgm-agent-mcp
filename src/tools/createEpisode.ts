import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  overviewViewSchema,
  scenarioConstraintSpecSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerCreateEpisode = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_create_episode",
    {
      title: "Create Basketball GM Episode",
      description:
        "Create an isolated, seeded research episode running in its own worker and return its initial normalized overview state. Call this before any other bbgm_* tool; save the returned episodeId and revision.",
      inputSchema: z
        .object({
          scenarioId: z
            .string()
            .min(1)
            .max(100)
            .describe(
              "Research scenario identifier; grouped in trajectory logs",
            ),
          seed: z
            .string()
            .min(1)
            .max(100)
            .describe(
              "Deterministic episode seed; same seed + same action sequence reproduces the same state hashes",
            ),
          userTeamId: z
            .number()
            .int()
            .nonnegative()
            .default(0)
            .describe("Team ID controlled by the agent"),
          startingSeason: z.number().int().min(1900).max(2200).default(2026),
          constraints: scenarioConstraintSpecSchema
            .optional()
            .describe(
              "Hard constraints and soft objectives this episode should be scored against",
            ),
        })
        .strict(),
      outputSchema: overviewViewSchema,
      annotations: toolAnnotations.createEpisode,
    },
    async (input) => {
      try {
        return success(await domain.createEpisode(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
};
