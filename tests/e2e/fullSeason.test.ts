import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import type { OverviewView } from "../../src/domain/types.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { readTrajectory } from "../../src/research/trajectory.js";
import { trajectoryPathFor } from "../../src/persistence/trajectoryLog.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

/**
 * "Smoke episode that advances through one complete season" against the
 * engine-independent fake, proving the season/phase/draft/free-agency state
 * machine and the full mutation pipeline hold up over many consecutive
 * mutations. This is a machinery proof, not a real-engine proof -- the
 * equivalent run against the real Basketball GM engine is scripts/smoke-engine.mts
 * (gated behind a real BBGM_SOURCE_DIR checkout; see docs/ENGINE_INTEGRATION.md).
 */
describe("full-season smoke episode (fake engine)", () => {
  test("advances from preseason back to the next preseason, handling the mandatory draft along the way", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "bbgm-full-season-"));
    try {
      const episodes = new EpisodeManager(
        () => new FakeSimulationEngine(),
        dataRoot,
      );
      const domain = new DomainService(
        episodes,
        createFileSnapshotStore(dataRoot),
      );

      const initial = await domain.createEpisode({
        scenarioId: "full-season-smoke",
        seed: "full-season-seed",
        userTeamId: 0,
        startingSeason: 2026,
      });
      expect(initial.phase).toBe("preseason");
      expect(initial.season).toBe(2026);

      let overview: OverviewView = initial;
      let revision = initial.revision;
      let mutations = 0;
      const MAX_MUTATIONS = 200;

      while (overview.season === 2026 && mutations < MAX_MUTATIONS) {
        if (overview.nextDecision === "make_draft_pick") {
          const draft = await domain.getState({
            episodeId: overview.episodeId,
            view: "draft",
          });
          if (draft.view !== "draft") throw new Error("expected draft view");
          const prospect = draft.prospects[0];
          if (!prospect)
            throw new Error(
              "expected an available prospect while blocked on make_draft_pick",
            );
          const result = await domain.makeDraftPick(
            overview.episodeId,
            { pid: prospect.pid },
            {
              expectedRevision: revision,
              idempotencyKey: `full-season-draft-${mutations}`,
            },
          );
          revision = result.revision;
        } else {
          const result = await domain.advance(
            overview.episodeId,
            { target: "next_decision" },
            {
              expectedRevision: revision,
              idempotencyKey: `full-season-advance-${mutations}`,
            },
          );
          revision = result.revision;
        }
        mutations += 1;
        overview = (await domain.getState({
          episodeId: overview.episodeId,
          view: "overview",
        })) as OverviewView;
      }

      expect(overview.season).toBe(2027);
      expect(mutations).toBeLessThan(MAX_MUTATIONS);
      expect(overview.userTeam.won + overview.userTeam.lost).toBeGreaterThan(0);

      const end = await domain.endEpisode(overview.episodeId, {
        exportFinalSnapshot: true,
      });
      expect(end.terminalMetrics.seasonsCompleted).toBeGreaterThanOrEqual(1);
      await domain.closeAll();

      const trajectory = await readTrajectory(
        trajectoryPathFor(dataRoot, overview.episodeId),
      );
      expect(trajectory.length).toBe(mutations + 3); // + create_episode + final checkpoint + end_episode
      expect(trajectory.at(0)?.step).toBe("create_episode");
      expect(trajectory.at(-1)?.step).toBe("end_episode");
      expect(trajectory.map((record) => record.sequence)).toEqual(
        trajectory.map((_, index) => index),
      );
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
