import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import { episodeIdSchema, overviewViewSchema } from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerResumeEpisode = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_resume_episode",
    {
      title: "Resume Basketball GM Episode",
      description:
        "Rehydrate an episode from its durable metadata and current snapshot after a process restart. The pinned engine version must match the one recorded when the episode was created.",
      inputSchema: z.object({ episodeId: episodeIdSchema }).strict(),
      outputSchema: overviewViewSchema,
      annotations: toolAnnotations.resumeEpisode,
    },
    async ({ episodeId }) => {
      try {
        return success(
          await domain.resumeEpisode(episodeId),
          overviewViewSchema,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
