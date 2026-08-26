import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import { endEpisodeResultSchema, episodeIdSchema } from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerEndEpisode = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_end_episode",
    {
      title: "End Episode",
      description:
        "Finalize an episode: flushes the trajectory log, optionally exports a final checkpoint, computes terminal metrics, and terminates the episode's worker. Terminal -- no further mutations are possible on this episodeId afterward.",
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          exportFinalSnapshot: z
            .boolean()
            .default(true)
            .describe("Persist a final checkpoint before closing"),
        })
        .strict(),
      outputSchema: endEpisodeResultSchema,
      annotations: toolAnnotations.endEpisode,
    },
    async ({ episodeId, exportFinalSnapshot }) => {
      try {
        return success(
          await domain.endEpisode(episodeId, { exportFinalSnapshot }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
