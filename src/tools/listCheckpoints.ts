import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import {
  listCheckpointsInputSchema,
  listCheckpointsResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerListCheckpoints = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_list_checkpoints",
    {
      title: "List Episode Checkpoints",
      description:
        "List the opaque checkpoints created for an episode. This does not mutate simulation state.",
      inputSchema: listCheckpointsInputSchema,
      outputSchema: listCheckpointsResultSchema,
      annotations: toolAnnotations.read,
    },
    async ({ episodeId }) => {
      try {
        return success(
          { checkpoints: domain.listCheckpoints(episodeId) },
          listCheckpointsResultSchema,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
