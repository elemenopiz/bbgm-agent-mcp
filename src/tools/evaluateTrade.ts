import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  episodeIdSchema,
  tradeEvaluationSchema,
  tradeProposalSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerEvaluateTrade = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_evaluate_trade",
    {
      title: "Evaluate Trade (Dry Run)",
      description:
        "Dry-run a proposed trade for legality, roster and payroll effects, and opponent acceptance where the engine can determine it. This is strictly read-only and never mutates state or consumes an idempotencyKey; call it as many times as needed while exploring offers before bbgm_execute_trade.",
      inputSchema: z
        .object({ episodeId: episodeIdSchema, proposal: tradeProposalSchema })
        .strict(),
      outputSchema: tradeEvaluationSchema,
      annotations: toolAnnotations.dryRun,
    },
    async ({ episodeId, proposal }) => {
      try {
        return success(await domain.evaluateTrade(episodeId, proposal));
      } catch (error) {
        return failure(error);
      }
    },
  );
};
