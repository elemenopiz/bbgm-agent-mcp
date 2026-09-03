import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { createServer } from "../../src/server/createServer.js";
import { failure, success } from "../../src/server/results.js";
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

/** Every state-mutating tool except the lifecycle tools requires the standard mutation-safety envelope. */
const MUTATION_SAFETY_EXEMPT = new Set([
  "bbgm_create_episode",
  "bbgm_resume_episode",
  "bbgm_get_state",
  "bbgm_get_options",
  "bbgm_get_player",
  "bbgm_evaluate_trade",
  "bbgm_create_checkpoint",
  "bbgm_list_checkpoints",
  // terminal lifecycle action, not a revision-bearing state mutation -- idempotent by construction
  // (ending an already-ended episode fails closed with ILLEGAL_ACTION rather than needing a replay key)
  "bbgm_end_episode",
]);

const READ_ONLY_TOOLS = new Set([
  "bbgm_get_state",
  "bbgm_get_options",
  "bbgm_get_player",
  "bbgm_evaluate_trade",
  "bbgm_list_checkpoints",
]);

const NON_DESTRUCTIVE_TOOLS = new Set([
  "bbgm_create_episode",
  "bbgm_create_checkpoint",
]);

const EXPECTED_TOOL_NAMES = [
  "bbgm_create_episode",
  "bbgm_resume_episode",
  "bbgm_create_checkpoint",
  "bbgm_list_checkpoints",
  "bbgm_restore_checkpoint",
  "bbgm_get_state",
  "bbgm_get_options",
  "bbgm_get_player",
  "bbgm_evaluate_trade",
  "bbgm_execute_trade",
  "bbgm_advertise_on_trading_block",
  "bbgm_set_lineup",
  "bbgm_release_player",
  "bbgm_negotiate_contract",
  "bbgm_sign_free_agent",
  "bbgm_make_draft_pick",
  "bbgm_advance",
  "bbgm_end_episode",
];

describe("tool catalog contract", () => {
  test("registers the fixed catalog in deterministic order", async () => {
    const first = await client.listTools();
    const second = await client.listTools();
    expect(first.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(second.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(new Set(EXPECTED_TOOL_NAMES).size).toBe(EXPECTED_TOOL_NAMES.length);
  });

  test("advertises a static tools capability without list-change notifications", () => {
    expect(client.getServerCapabilities()?.tools).toEqual({
      listChanged: false,
    });
  });

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

  test("non-destructive lifecycle tools are not mislabeled read-only", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools.filter((t) =>
      NON_DESTRUCTIVE_TOOLS.has(t.name),
    )) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
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

  test("bbgm_restore_checkpoint requires the mutation envelope", async () => {
    const listed = await client.listTools();
    const checkpoint = listed.tools.find(
      (t) => t.name === "bbgm_restore_checkpoint",
    );
    expect(checkpoint).toBeDefined();
    const schema = checkpoint!.inputSchema as {
      properties?: Record<string, unknown>;
    };
    for (const field of [
      "episodeId",
      "checkpointId",
      "expectedRevision",
      "idempotencyKey",
    ]) {
      expect(schema.properties?.[field]).toBeDefined();
    }
  });

  test("every tool's output schema is an object type", async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const schema = tool.outputSchema as { type?: string } | undefined;
      expect(schema?.type, tool.name).toBe("object");
    }
  });

  test("server result helpers enforce output schemas and sanitize failures", () => {
    expect(() =>
      success({}, { safeParse: () => ({ success: false }) }),
    ).toThrow("failed its declared output schema");

    const rawFailure = Object.assign(
      new Error("/private/engine/path stack trace should not escape"),
      { code: "ENGINE_ERROR" },
    );
    const failureResult = failure(rawFailure);
    const failureText =
      (failureResult.content as { type: string; text?: string }[])[0]?.text ??
      "";
    expect(JSON.parse(failureText)).toEqual({
      error: {
        code: "ENGINE_ERROR",
        message: "Internal engine error",
        retryable: false,
      },
    });

    const structuredFailure = failure(
      Object.assign(new Error("Player refuses this offer"), {
        code: "ILLEGAL_ACTION",
        retryable: false,
        details: { pid: 42, reason: "upstream_negotiation_preflight_rejected" },
      }),
    );
    const structuredText =
      (structuredFailure.content as { type: string; text?: string }[])[0]
        ?.text ?? "";
    expect(JSON.parse(structuredText)).toEqual({
      error: {
        code: "ILLEGAL_ACTION",
        message: "Player refuses this offer",
        retryable: false,
        details: { pid: 42, reason: "upstream_negotiation_preflight_rejected" },
      },
    });

    const timeoutResult = failure(
      Object.assign(new Error("/private/engine/path"), { code: "TIMEOUT" }),
    );
    const timeoutText =
      (timeoutResult.content as { type: string; text?: string }[])[0]?.text ??
      "";
    expect(JSON.parse(timeoutText)).toMatchObject({
      error: {
        code: "TIMEOUT",
        retryable: true,
        message:
          "The engine worker timed out; resume the quarantined episode before retrying",
      },
    });
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
