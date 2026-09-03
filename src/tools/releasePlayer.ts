import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
  pidSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerReleasePlayer = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_release_player",
    {
      title: "Release Player",
      description:
        "Waive a player from the user's roster to free agency, freeing a roster slot but not cap space until the engine reflects it. The player must currently be on the user's roster. Not allowed during the draft phase.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          pid: pidSchema,
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, pid }) => {
      try {
        return success(
          await domain.releasePlayer(
            episodeId,
            { pid },
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
