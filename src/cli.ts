#!/usr/bin/env node
import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { DomainService } from "./domain/DomainService.js";
import { BasketballGmEngine } from "./engine/bbgm/BasketballGmEngine.js";
import { createLogger } from "./logging/logger.js";
import { createFileSnapshotStore } from "./persistence/snapshots.js";
import { createServer } from "./server/createServer.js";
import { EpisodeManager } from "./sessions/EpisodeManager.js";

const logger = createLogger("cli");

const dataRoot = resolve(process.env["BBGM_DATA_ROOT"] ?? ".data");

const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));
const handle = serveStdio(() => createServer(domain));

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  void domain
    .closeAll()
    .catch((error: unknown) =>
      logger.error("error during shutdown", {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      void handle.close();
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info("bbgm-agent-mcp listening on stdio", { dataRoot });
