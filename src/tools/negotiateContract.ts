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

export const registerNegotiateContract = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_negotiate_contract",
    {
      title: "Negotiate Contract Extension",
      description:
        "Extend or renegotiate the contract of a player already on the user's roster. The player must currently be on the user's roster. Not allowed during the draft phase.",
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
          await domain.negotiateContract(
            episodeId,
            { pid, amount, years },
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
