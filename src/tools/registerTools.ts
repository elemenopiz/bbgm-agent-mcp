import type { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import { registerAdvance } from "./advance.js";
import { registerCreateEpisode } from "./createEpisode.js";
import { registerCreateCheckpoint } from "./createCheckpoint.js";
import { registerEndEpisode } from "./endEpisode.js";
import { registerEvaluateTrade } from "./evaluateTrade.js";
import { registerExecuteTrade } from "./executeTrade.js";
import { registerGetOptions } from "./getOptions.js";
import { registerGetPlayer } from "./getPlayer.js";
import { registerGetState } from "./getState.js";
import { registerMakeDraftPick } from "./makeDraftPick.js";
import { registerNegotiateContract } from "./negotiateContract.js";
import { registerReleasePlayer } from "./releasePlayer.js";
import { registerListCheckpoints } from "./listCheckpoints.js";
import { registerResumeEpisode } from "./resumeEpisode.js";
import { registerRestoreCheckpoint } from "./restoreCheckpoint.js";
import { registerSetLineup } from "./setLineup.js";
import { registerSignFreeAgent } from "./signFreeAgent.js";

export const registerTools = (
  server: McpServer,
  domain: DomainService,
): void => {
  registerCreateEpisode(server, domain);
  registerResumeEpisode(server, domain);
  registerCreateCheckpoint(server, domain);
  registerListCheckpoints(server, domain);
  registerRestoreCheckpoint(server, domain);
  registerGetState(server, domain);
  registerGetOptions(server, domain);
  registerGetPlayer(server, domain);
  registerEvaluateTrade(server, domain);
  registerExecuteTrade(server, domain);
  registerSetLineup(server, domain);
  registerReleasePlayer(server, domain);
  registerNegotiateContract(server, domain);
  registerSignFreeAgent(server, domain);
  registerMakeDraftPick(server, domain);
  registerAdvance(server, domain);
  registerEndEpisode(server, domain);
};
