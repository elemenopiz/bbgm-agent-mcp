#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { DemoEngine } from "./engine/demo/DemoEngine.js";
import { BasketballGmEngine } from "./engine/bbgm/BasketballGmEngine.js";
import { createServer } from "./server/createServer.js";
import { EpisodeManager } from "./sessions/EpisodeManager.js";

const engineName = process.env["BBGM_ENGINE"] ?? "real";

if (engineName !== "demo" && engineName !== "real") {
  console.error(`Unknown BBGM_ENGINE value: ${engineName}`);
  process.exitCode = 1;
} else {
  const episodes = new EpisodeManager(() =>
    engineName === "demo" ? new DemoEngine() : new BasketballGmEngine(),
  );
  const handle = serveStdio(() => createServer(episodes));

  const shutdown = (): void => {
    void episodes.close().finally(() => handle.close());
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.error(`bbgm-agent-mcp is listening on stdio with the ${engineName} engine`);
}
