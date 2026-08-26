import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";

import { DemoEngine } from "../src/engine/demo/DemoEngine.js";
import { createServer } from "../src/server/createServer.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";

const managers: EpisodeManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

describe("MCP server", () => {
  test("lists schema-backed tools and runs an episode", async () => {
    const manager = new EpisodeManager(() => new DemoEngine());
    managers.push(manager);
    const server = createServer(manager);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toContain("bbgm_create_episode");
    expect(listed.tools.every(({ inputSchema }) => inputSchema.type === "object")).toBe(true);

    const created = await client.callTool({
      name: "bbgm_create_episode",
      arguments: { scenarioId: "mcp", seed: "123", userTeamId: 0, startingSeason: 2026 },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ revision: 0, scenarioId: "mcp" });

    await client.close();
    await server.close();
  });
});

