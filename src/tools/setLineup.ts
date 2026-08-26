import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
  setLineupInputSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerSetLineup = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_set_lineup",
    {
      title: "Set Roster Depth Chart",
      description:
        "Set the roster's depth-chart order (playing-time priority). The order array must contain exactly the current roster's player IDs, most-preferred first; read the roster via bbgm_get_state(view=\"roster\") first. Not allowed during the draft phase.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          order: setLineupInputSchema.shape.order,
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, order }) => {
      try {
        return success(
          await domain.setLineup(
            episodeId,
            { order },
            { expectedRevision, idempotencyKey },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
