import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import {
  restoreCheckpointInputSchema,
  restoreCheckpointResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerRestoreCheckpoint = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_restore_checkpoint",
    {
      title: "Restore Episode Checkpoint",
      description:
        "Restore a previously created checkpoint. This is a revision-bearing mutation: the simulation state may move backward, but the episode revision always advances and the action is retry-safe with an idempotency key.",
      inputSchema: restoreCheckpointInputSchema,
      outputSchema: restoreCheckpointResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, checkpointId, expectedRevision, idempotencyKey }) => {
      try {
        return success(
          {
            mutation: await domain.restoreCheckpoint(episodeId, checkpointId, {
              expectedRevision,
              idempotencyKey,
            }),
          },
          restoreCheckpointResultSchema,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
