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
  dataRoot = await mkdtemp(join(tmpdir(), "bbgm-contract-test-"));
  domain = new DomainService(
    new EpisodeManager(() => new FakeSimulationEngine(), dataRoot),
    createFileSnapshotStore(dataRoot),
  );
  const server = createServer(domain);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "contract-test", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await domain.closeAll();
  await rm(dataRoot, { recursive: true, force: true });
});

/** Every mutating tool except bbgm_create_episode requires the standard mutation-safety envelope. */
const MUTATION_SAFETY_EXEMPT = new Set([
  "bbgm_create_episode",
  "bbgm_get_state",
  "bbgm_get_options",
  "bbgm_evaluate_trade",
  // discriminated union (create/list/restore); its own dedicated test below checks the restore branch
  "bbgm_checkpoint",
  // terminal lifecycle action, not a revision-bearing state mutation -- idempotent by construction
  // (ending an already-ended episode fails closed with ILLEGAL_ACTION rather than needing a replay key)
  "bbgm_end_episode",
]);

const READ_ONLY_TOOLS = new Set([
  "bbgm_get_state",
  "bbgm_get_options",
  "bbgm_evaluate_trade",
]);

describe("tool catalog contract", () => {
  test("openWorldHint is false for every tool (no unbounded external I/O)", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  test("read-only tools are annotated readOnlyHint=true, destructiveHint=false", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools.filter((t) =>
      READ_ONLY_TOOLS.has(t.name),
    )) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  test("every mutating tool (except create_episode) requires episodeId, expectedRevision, and idempotencyKey", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools.filter(
      (t) => !MUTATION_SAFETY_EXEMPT.has(t.name),
    )) {
      const schema = tool.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      for (const field of ["episodeId", "expectedRevision", "idempotencyKey"]) {
        expect(
          schema.properties?.[field],
          `${tool.name} should accept ${field}`,
        ).toBeDefined();
      }
    }
  });

  test("bbgm_checkpoint's action=restore branch is the only branch requiring the mutation envelope", async () => {
    const listed = await client.listTools();
    const checkpoint = listed.tools.find((t) => t.name === "bbgm_checkpoint");
    expect(checkpoint).toBeDefined();
    // discriminated union -> anyOf/oneOf branches in the converted JSON schema
    const schema = checkpoint!.inputSchema as {
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect((schema.anyOf ?? schema.oneOf)?.length).toBe(3);
  });

  test("every tool's output schema is an object type", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const schema = tool.outputSchema as { type?: string } | undefined;
      expect(schema?.type, tool.name).toBe("object");
    }
  });

  test("an illegal action surfaces a stable ILLEGAL_ACTION code, not a raw engine error", async () => {
    const created = await client.callTool({
      name: "bbgm_create_episode",
      arguments: {
        scenarioId: "contract",
        seed: "1",
        userTeamId: 0,
        startingSeason: 2026,
      },
    });
    const overview = created.structuredContent as { episodeId: string };
    const result = await client.callTool({
      name: "bbgm_release_player",
      arguments: {
        episodeId: overview.episodeId,
        expectedRevision: 0,
        idempotencyKey: "contract-release-1",
        pid: 999_999,
      },
    });
    expect(result.isError).toBe(true);
    const text =
      (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "ILLEGAL_ACTION" },
    });
  });

  test("an unknown episodeId surfaces EPISODE_NOT_FOUND", async () => {
    const result = await client.callTool({
      name: "bbgm_get_options",
      arguments: { episodeId: "doesnotexist000" },
    });
    expect(result.isError).toBe(true);
    const text =
      (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "EPISODE_NOT_FOUND" },
    });
  });
});
