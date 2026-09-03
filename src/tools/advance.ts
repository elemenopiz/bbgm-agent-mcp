import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  advanceInputObjectSchema,
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerAdvance = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_advance",
    {
      title: "Advance Simulation",
      description:
        "Advance simulated time by a bounded target: next_game, next_decision, explicit days/games, week, month, one_pick, phase, season_end, or a named upstream milestone such as until_trade_deadline, until_playoffs, until_draft, until_next_pick, until_free_agency, until_preseason, or until_regular_season. The episode's allowedAdvanceTargets policy can narrow this list. Advancement stops at a mandatory user decision such as a pending draft pick; the returned events include an advance_complete entry explaining why it stopped.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          target: advanceInputObjectSchema.shape.target,
          count: advanceInputObjectSchema.shape.count,
        })
        .strict()
        .refine(
          (value) =>
            value.target === "days" || value.target === "games"
              ? value.count !== undefined
              : true,
          {
            message: "count is required when target is days or games",
            path: ["count"],
          },
        ),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, target, count }) => {
      try {
        return success(
          await domain.advance(
            episodeId,
            count === undefined ? { target } : { target, count },
            { expectedRevision, idempotencyKey },
          ),
          mutationResultSchema,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
