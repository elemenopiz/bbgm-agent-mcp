import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import {
  checkpointActionInputSchema,
  checkpointResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerCheckpoint = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_checkpoint",
    {
      title: "Manage Checkpoints",
      description:
        "Create, list, or restore episode checkpoints, addressed by opaque checkpointId (never a filesystem path). action=create and action=list are read-only. action=restore is a mutation: it requires expectedRevision and idempotencyKey, and advances the episode's revision even though league state may move backward in simulated time.",
      inputSchema: checkpointActionInputSchema,
      outputSchema: checkpointResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async (input) => {
      try {
        if (input.action === "create") {
          return success({
            action: input.action,
            checkpoint: await domain.createCheckpoint(input.episodeId),
          });
        }
        if (input.action === "list") {
          return success({
            action: input.action,
            checkpoints: domain.listCheckpoints(input.episodeId),
          });
        }
        return success({
          action: input.action,
          mutation: await domain.restoreCheckpoint(
            input.episodeId,
            input.checkpointId,
            {
              expectedRevision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
            },
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
};
