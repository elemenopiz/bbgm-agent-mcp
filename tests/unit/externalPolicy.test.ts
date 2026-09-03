import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { ExternalPolicyRunner } from "../../experiments/external-policy/runner.js";
import { externalActionSchema } from "../../experiments/external-policy/types.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

describe("external policy contract", () => {
  it("validates every supported external action category", () => {
    const actions = [
      {
        toolName: "bbgm_get_state",
        arguments: { view: "overview" },
      },
      { toolName: "bbgm_get_options", arguments: {} },
      {
        toolName: "bbgm_evaluate_trade",
        arguments: { otherTeamId: 1, offered: [], requested: [] },
      },
      {
        toolName: "bbgm_execute_trade",
        arguments: { otherTeamId: 1, offered: [], requested: [] },
      },
      { toolName: "bbgm_set_lineup", arguments: { order: [1, 2] } },
      { toolName: "bbgm_release_player", arguments: { pid: 1 } },
      {
        toolName: "bbgm_negotiate_contract",
        arguments: { pid: 1, amount: 10, years: 2 },
      },
      {
        toolName: "bbgm_sign_free_agent",
        arguments: { pid: 1, amount: 10, years: 2 },
      },
      { toolName: "bbgm_make_draft_pick", arguments: { pid: 1 } },
      { toolName: "bbgm_advance", arguments: { target: "next_game" } },
      { toolName: "bbgm_create_checkpoint", arguments: {} },
      { toolName: "bbgm_list_checkpoints", arguments: {} },
      {
        toolName: "bbgm_restore_checkpoint",
        arguments: { checkpointId: "checkpoint-1" },
      },
    ] as const;

    for (const action of actions) {
      expect(externalActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it("rejects an action disallowed by the scenario before engine invocation", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "bbgm-external-policy-test-"),
    );
    const domain = new DomainService(
      new EpisodeManager(() => new FakeSimulationEngine(), dataRoot),
      createFileSnapshotStore(dataRoot),
    );
    const records: unknown[] = [];

    try {
      const overview = await domain.createEpisode({
        scenarioId: "external-policy-test",
        seed: "external-policy-seed",
        userTeamId: 0,
        startingSeason: 2026,
        scenarioPolicy: {
          allowedInformation: ["overview"],
          allowedActions: ["advance"],
        },
      });
      const runner = new ExternalPolicyRunner(
        domain,
        overview.episodeId,
        () => ({
          toolName: "bbgm_execute_trade",
          arguments: { otherTeamId: 9001, offered: [], requested: [] },
        }),
        {
          append: async (record) => {
            records.push(record);
          },
        },
        "policy-test",
        {
          allowedInformation: ["overview"],
          allowedActions: ["advance"],
        },
      );

      await expect(runner.run(1)).rejects.toThrow(
        "Scenario does not allow action: execute_trade",
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        failure: { stage: "policy", code: "ACTION_NOT_ALLOWED" },
        idempotency: { status: "not_applicable" },
        revision: { before: 0, after: null },
        toolResult: null,
      });

      const after = await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      });
      expect(after.revision).toBe(0);
    } finally {
      await domain.closeAll();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
