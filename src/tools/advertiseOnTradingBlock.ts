import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  advertiseOnTradingBlockInputSchema,
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerAdvertiseOnTradingBlock = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_advertise_on_trading_block",
    {
      title: "Advertise On Trading Block",
      description:
        'Advertise roster players and/or owned draft picks on the trading block, replacing any previous advertisement. Returns AI-generated counter-offers via bbgm_get_state(view="trading_block") after this call; the offers themselves are not returned inline since generating them is asynchronous engine work. Pass empty pids/dpids arrays to clear the trading block. Untradable players and picks not owned by the user are rejected. Not allowed during the draft phase. To act on a received offer (from either this or bbgm_get_state(view="trade_proposals")), construct an equivalent trade (otherTeamId=offer.otherTeamId, offered=offer.offered, requested=offer.requested) and call bbgm_execute_trade -- there is no separate "accept" tool.',
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          pids: advertiseOnTradingBlockInputSchema.shape.pids,
          dpids: advertiseOnTradingBlockInputSchema.shape.dpids,
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, pids, dpids }) => {
      try {
        return success(
          await domain.advertiseOnTradingBlock(
            episodeId,
            { pids, dpids },
            { expectedRevision, idempotencyKey },
          ),
          mutationResultSchema,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
