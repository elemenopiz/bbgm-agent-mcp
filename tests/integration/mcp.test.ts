import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { createServer } from "../../src/server/createServer.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

let dataRoot: string;
let domain: DomainService;
let client: Client;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "bbgm-mcp-test-"));
  domain = new DomainService(
    new EpisodeManager(() => new FakeSimulationEngine(), dataRoot),
    createFileSnapshotStore(dataRoot),
  );
  const server = createServer(domain);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await domain.closeAll();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("MCP server", () => {
  test("lists all 13 tools, each with an input and output schema", async () => {
    const listed = await client.listTools();
    const expectedNames = [
      "bbgm_create_episode",
      "bbgm_get_state",
      "bbgm_get_options",
      "bbgm_evaluate_trade",
      "bbgm_execute_trade",
      "bbgm_set_lineup",
      "bbgm_release_player",
      "bbgm_negotiate_contract",
      "bbgm_sign_free_agent",
      "bbgm_make_draft_pick",
      "bbgm_advance",
      "bbgm_checkpoint",
      "bbgm_end_episode",
    ];
    const names = listed.tools.map((tool) => tool.name);
    for (const name of expectedNames) expect(names).toContain(name);
    expect(listed.tools).toHaveLength(expectedNames.length);
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
  });

  test("runs a full episode lifecycle end to end through the protocol", async () => {
    const created = await client.callTool({
      name: "bbgm_create_episode",
      arguments: {
        scenarioId: "mcp-e2e",
        seed: "42",
        userTeamId: 0,
        startingSeason: 2026,
      },
    });
    expect(created.isError).not.toBe(true);
    const overview = created.structuredContent as {
      episodeId: string;
      revision: number;
    };
    expect(overview.revision).toBe(0);

    const options = await client.callTool({
      name: "bbgm_get_options",
      arguments: { episodeId: overview.episodeId },
    });
    expect(options.isError).not.toBe(true);

    const advanced = await client.callTool({
      name: "bbgm_advance",
      arguments: {
        episodeId: overview.episodeId,
        expectedRevision: 0,
        idempotencyKey: "e2e-advance-0001",
        target: "next_game",
      },
    });
    expect(advanced.isError).not.toBe(true);
    expect((advanced.structuredContent as { revision: number }).revision).toBe(
      1,
    );

    const ended = await client.callTool({
      name: "bbgm_end_episode",
      arguments: { episodeId: overview.episodeId, exportFinalSnapshot: false },
    });
    expect(ended.isError).not.toBe(true);
  });

  test("returns a stable error code for a stale revision instead of throwing a transport error", async () => {
    const created = await client.callTool({
      name: "bbgm_create_episode",
      arguments: {
        scenarioId: "mcp-conflict",
        seed: "1",
        userTeamId: 0,
        startingSeason: 2026,
      },
    });
    const overview = created.structuredContent as { episodeId: string };

    await client.callTool({
      name: "bbgm_advance",
      arguments: {
        episodeId: overview.episodeId,
        expectedRevision: 0,
        idempotencyKey: "conflict-1",
        target: "next_game",
      },
    });
    const stale = await client.callTool({
      name: "bbgm_advance",
      arguments: {
        episodeId: overview.episodeId,
        expectedRevision: 0,
        idempotencyKey: "conflict-2",
        target: "next_game",
      },
    });
    expect(stale.isError).toBe(true);
    const text =
      (stale.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "REVISION_CONFLICT" },
    });
  });

  test("rejects invalid arguments before the handler runs, with no stack trace leaked", async () => {
    const result = await client.callTool({
      name: "bbgm_create_episode",
      arguments: {
        scenarioId: "",
        seed: "1",
        extraUnknownField: "not allowed",
      },
    });
    expect(result.isError).toBe(true);
    const text =
      (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).not.toMatch(/at .*\.ts:\d+/);
  });

  test("bbgm_evaluate_trade never mutates state", async () => {
    const created = await client.callTool({
      name: "bbgm_create_episode",
      arguments: {
        scenarioId: "mcp-trade",
        seed: "7",
        userTeamId: 0,
        startingSeason: 2026,
      },
    });
    const overview = created.structuredContent as {
      episodeId: string;
      revision: number;
    };
    await client.callTool({
      name: "bbgm_evaluate_trade",
      arguments: {
        episodeId: overview.episodeId,
        proposal: { otherTeamId: 9001, offered: [], requested: [] },
      },
    });
    const state = await client.callTool({
      name: "bbgm_get_state",
      arguments: { episodeId: overview.episodeId, view: "overview" },
    });
    expect((state.structuredContent as { revision: number }).revision).toBe(0);
  });
});
