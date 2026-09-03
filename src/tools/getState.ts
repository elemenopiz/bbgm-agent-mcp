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
        'Read a bounded, paginated slice of normalized league state for an episode. Never mutates. Choose the narrowest view for your question: overview (default situational summary), roster, finances, standings, schedule, free_agents, draft, transactions, objectives, constraints, trading_block, or trade_proposals. Large lists are paginated via cursor/limit; this never dumps the entire league in one call. The draft view includes the complete current-owner pick ledger plus the user\'s ownedPicks convenience subset. For view="roster", pass teamId to inspect another team\'s public roster (e.g. before proposing a trade) -- omit it to read the user\'s own roster. view="trading_block" returns what the user has currently advertised, the AI counter-offers for it, and the roster players / owned picks eligible to advertise (see bbgm_advertise_on_trading_block); view="trade_proposals" returns up to 5 AI-initiated offers the user did not solicit. Offers from either view can be executed directly via bbgm_execute_trade (otherTeamId=offer.otherTeamId, offered=offer.offered, requested=offer.requested) -- there is no separate accept tool.',
      inputSchema: getStateInputSchema,
      outputSchema: leagueStateViewSchema,
      annotations: toolAnnotations.read,
    },
    async (input) => {
      try {
        return success(await domain.getState(input), leagueStateViewSchema);
      } catch (error) {
        return failure(error);
      }
    },
  );
};
