import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import {
  getStateInputSchema,
  leagueStateViewSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerGetState = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_get_state",
    {
      title: "Observe League State",
      description:
        "Read a bounded, paginated slice of normalized league state for an episode. Never mutates. Choose the narrowest view for your question: overview (default situational summary), roster, finances, standings, schedule, free_agents, draft, transactions, objectives, or constraints. Large lists are paginated via cursor/limit; this never dumps the entire league in one call.",
      inputSchema: getStateInputSchema,
      outputSchema: leagueStateViewSchema,
      annotations: toolAnnotations.read,
    },
    async (input) => {
      try {
        return success(await domain.getState(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
};
