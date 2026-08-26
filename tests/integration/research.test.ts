import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import { scalarReward } from "../../src/research/objectives.js";
import { runEvaluation } from "../../src/research/evaluate.js";
import type { ScenarioManifest } from "../../src/research/scenario.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

const scenario: ScenarioManifest = {
  scenarioId: "research-harness-smoke",
  description:
    "Exercises the research harness end to end against the fake engine.",
  seedSet: ["research-seed-1"],
  userTeamId: 0,
  startingSeason: 2026,
  horizonSeasons: 1,
  hardConstraints: [],
  softObjectives: [
    { code: "MAXIMIZE_WINS", description: "Maximize wins", weight: 1 },
  ],
  allowedInformation: ["overview", "roster", "draft", "free_agents"],
  allowedActions: [
    "advance",
    "make_draft_pick",
    "sign_free_agent",
    "release_player",
  ],
  maxSteps: 60,
};

describe("research evaluation harness", () => {
  test("the heuristic policy completes a bounded run against the fake engine and produces metrics", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "bbgm-research-test-"));
    try {
      const episodes = new EpisodeManager(
        () => new FakeSimulationEngine(),
        dataRoot,
      );
      const domain = new DomainService(
        episodes,
        createFileSnapshotStore(dataRoot),
      );

      const result = await runEvaluation({
        scenario,
        seed: "research-seed-1",
        policyName: "heuristic",
        domain,
        dataRoot,
      });
      await domain.closeAll();

      expect(result.scenarioId).toBe(scenario.scenarioId);
      expect(result.stepsTaken).toBeGreaterThan(0);
      expect(result.stepsTaken).toBeLessThanOrEqual(scenario.maxSteps);
      expect(result.terminalMetrics.episodeId).toBe(result.episodeId);
      expect(result.metricComponents["win_pct"]).toBeGreaterThanOrEqual(0);
      expect(result.trajectorySummary.totalSteps).toBeGreaterThan(0);

      const reward = scalarReward(result.metricComponents, {
        win_pct: 1,
        hard_constraint_violations: -1,
      });
      expect(Number.isFinite(reward)).toBe(true);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 20_000);

  test("the no_op policy stalls cleanly once it reaches a mandatory draft pick", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "bbgm-research-noop-test-"));
    try {
      const episodes = new EpisodeManager(
        () => new FakeSimulationEngine(),
        dataRoot,
      );
      const domain = new DomainService(
        episodes,
        createFileSnapshotStore(dataRoot),
      );

      const result = await runEvaluation({
        scenario: { ...scenario, horizonSeasons: 2, maxSteps: 200 },
        seed: "research-seed-1",
        policyName: "no_op",
        domain,
        dataRoot,
      });
      await domain.closeAll();

      expect(result.stallReason).toMatch(/mandatory draft pick/);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
