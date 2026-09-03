import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import {
  createCheckpointInputSchema,
  createCheckpointResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerCreateCheckpoint = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_create_checkpoint",
    {
      title: "Create Episode Checkpoint",
      description:
        "Persist an opaque checkpoint of the current episode state. This is read-only with respect to the simulation and can be restored later with bbgm_restore_checkpoint.",
      inputSchema: createCheckpointInputSchema,
      outputSchema: createCheckpointResultSchema,
      annotations: toolAnnotations.createCheckpoint,
    },
    async ({ episodeId }) => {
      try {
        return success(
          { checkpoint: await domain.createCheckpoint(episodeId) },
          createCheckpointResultSchema,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
