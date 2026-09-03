import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import { episodeIdSchema, optionsResultSchema } from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerGetOptions = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_get_options",
    {
      title: "List Legal GM Options",
      description:
        "List legal action categories and bounded candidate IDs for the current phase, stamped with the revision they were generated at. Options may go stale after any mutation; re-fetch after advancing or mutating before acting on them.",
      inputSchema: z.object({ episodeId: episodeIdSchema }).strict(),
      outputSchema: optionsResultSchema,
      annotations: toolAnnotations.read,
    },
    async ({ episodeId }) => {
      try {
        return success(await domain.getOptions(episodeId), optionsResultSchema);
      } catch (error) {
        return failure(error);
      }
    },
  );
};
