import { McpServer } from "@modelcontextprotocol/server";

import type { DomainService } from "../domain/DomainService.js";
import { WRAPPER_VERSION } from "../version.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerTools } from "../tools/registerTools.js";

export const createServer = (domain: DomainService): McpServer => {
  const server = new McpServer(
    { name: "bbgm-agent-mcp", version: WRAPPER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerTools(server, domain);

  return server;
};
