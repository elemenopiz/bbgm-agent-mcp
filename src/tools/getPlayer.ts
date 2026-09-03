import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import {
  getPlayerInputSchema,
  getPlayerResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerGetPlayer = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_get_player",
    {
      title: "Observe Player Detail",
      description:
        'Read deep detail for one player by pid -- the "click into a player" view after scanning a roster or free-agent list. Never mutates. Returns, per season: the full ratings history (overall, potential, and the 15 individual ratings) showing the development curve; basic stats (games, minutes, points, rebounds, assists, steals, blocks, turnovers, shooting percentages); and advanced stats (PER, offensive/defensive/total win shares, win shares per 48, offensive/defensive/total BPM, VORP, true shooting%, usage%). Also returns the current contract and full multi-year salary schedule, awards, draft info, and injury history (current and past). Every field is optional and degrades to empty/partial rather than erroring for an unknown pid. Does not expose the engine\'s internal composite player valuation.',
      inputSchema: getPlayerInputSchema,
      outputSchema: getPlayerResultSchema,
      annotations: toolAnnotations.read,
    },
    async (input) => {
      try {
        return success(await domain.getPlayer(input), getPlayerResultSchema);
      } catch (error) {
        return failure(error);
      }
    },
  );
};
