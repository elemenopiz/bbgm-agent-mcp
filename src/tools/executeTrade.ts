import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
  tradeProposalSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerExecuteTrade = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_execute_trade",
    {
      title: "Execute Trade",
      description:
        "Execute a previously inspected, legal trade. Always call bbgm_evaluate_trade first. Requires the current revision and a unique retry-safe idempotencyKey; a stale revision is rejected with REVISION_CONFLICT. Not allowed during the draft phase.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          proposal: tradeProposalSchema,
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, proposal }) => {
      try {
        return success(
          await domain.executeTrade(episodeId, proposal, {
            expectedRevision,
            idempotencyKey,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
