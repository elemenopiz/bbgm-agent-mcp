import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  contractTermsSchema,
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
  pidSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerSignFreeAgent = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_sign_free_agent",
    {
      title: "Sign Free Agent",
      description:
        "Sign an available free agent to the user's roster on the given contract terms. The player must currently be a free agent (not already rostered by any team). Not allowed during the draft phase.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          pid: pidSchema,
          amount: contractTermsSchema.shape.amount,
          years: contractTermsSchema.shape.years,
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({
      episodeId,
      expectedRevision,
      idempotencyKey,
      pid,
      amount,
      years,
    }) => {
      try {
        return success(
          await domain.signFreeAgent(
            episodeId,
            { pid, amount, years },
            { expectedRevision, idempotencyKey },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
