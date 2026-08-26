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
        "Advance simulated time by a bounded target: next_game (play one game), next_decision (advance until the next GM decision point or one game, whichever first), days or games (advance an explicit count, max 30), phase (advance to the next league phase), or season_end (advance to the next preseason). Advancement always stops at a decision point requiring GM input (e.g. pending draft picks) even if the target isn't reached yet; the returned events include an advance_complete entry explaining why it stopped.",
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
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
