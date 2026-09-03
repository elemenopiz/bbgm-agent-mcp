import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { DomainService } from "../domain/DomainService.js";
import {
  episodeIdSchema,
  expectedRevisionSchema,
  idempotencyKeySchema,
  mutationResultSchema,
  pidSchema,
} from "../domain/schemas.js";
import { toolAnnotations } from "../server/errors.js";
import { failure, success } from "../server/results.js";

export const registerMakeDraftPick = (
  server: McpServer,
  domain: DomainService,
): void => {
  server.registerTool(
    "bbgm_make_draft_pick",
    {
      title: "Make Draft Pick",
      description:
        'Select an available prospect with the user\'s next owned draft pick. Only allowed during the draft phase, and only when a prospect is currently available (see bbgm_get_state(view="draft") or bbgm_get_options). Fails with ILLEGAL_ACTION if no owned picks remain.',
      inputSchema: z
        .object({
          episodeId: episodeIdSchema,
          expectedRevision: expectedRevisionSchema,
          idempotencyKey: idempotencyKeySchema,
          pid: pidSchema.describe("Prospect ID to select"),
        })
        .strict(),
      outputSchema: mutationResultSchema,
      annotations: toolAnnotations.mutate,
    },
    async ({ episodeId, expectedRevision, idempotencyKey, pid }) => {
      try {
        return success(
          await domain.makeDraftPick(
            episodeId,
            { pid },
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
