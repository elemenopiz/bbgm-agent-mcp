import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import type { FinancesView, RosterView } from "../../src/domain/types.js";
import { BasketballGmEngine } from "../../src/engine/bbgm/BasketballGmEngine.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";

/**
 * Exercises the real Basketball GM engine end to end through DomainService --
 * the same path bbgm_* tools use, not just BasketballGmEngine directly --
 * against a real, separately-obtained zengm checkout. Requires BBGM_REAL_ENGINE=1
 * and a valid BBGM_SOURCE_DIR (see CONTRIBUTING.md); skipped otherwise so the
 * default `pnpm test` run never needs a checkout. This complements, but does
 * not replace, scripts/smoke-engine.mts (a standalone operator-facing script
 * with the same intent, run via `pnpm engine:smoke`).
 */
const runRealEngine = process.env["BBGM_REAL_ENGINE"] === "1";

describe.skipIf(!runRealEngine)("BasketballGmEngine (real engine)", () => {
  const dataRoots: string[] = [];
  const domains: DomainService[] = [];

  afterEach(async () => {
    await Promise.all(domains.splice(0).map((domain) => domain.closeAll()));
    await Promise.all(
      dataRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test(
    "creates a real league, inspects state, dry-runs a trade, makes one legal mutation, advances, and round-trips a snapshot",
    { timeout: 180_000 },
    async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "bbgm-real-engine-test-"));
      dataRoots.push(dataRoot);
      const episodes = new EpisodeManager(
        () => new BasketballGmEngine(),
        dataRoot,
      );
      const domain = new DomainService(
        episodes,
        createFileSnapshotStore(dataRoot),
      );
      domains.push(domain);

      const overview = await domain.createEpisode({
        scenarioId: "real-engine-integration-test",
        seed: "real-engine-test-seed",
        userTeamId: 0,
        startingSeason: new Date().getFullYear(),
      });
      expect(overview.status).toBe("active");
      expect(overview.rosterCount).toBeGreaterThan(0);

      const roster = (await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
      })) as RosterView;
      expect(roster.players.length).toBeGreaterThan(0);
      expect(roster.players[0]?.pid).toBeGreaterThan(0);

      const finances = (await domain.getState({
        episodeId: overview.episodeId,
        view: "finances",
      })) as FinancesView;
      expect(Number.isFinite(finances.payroll)).toBe(true);
      expect(Number.isFinite(finances.salaryCap)).toBe(true);

      // Trade dry run against an arbitrary other team -- must not mutate, and must not throw.
      const evaluation = await domain.evaluateTrade(overview.episodeId, {
        otherTeamId: (overview.userTeam.tid + 1) % 30,
        offered: [],
        requested: [],
      });
      expect(typeof evaluation.legal).toBe("boolean");
      const unchanged = await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      });
      expect(unchanged.revision).toBe(overview.revision);

      const checkpoint = await domain.createCheckpoint(overview.episodeId);
      expect(checkpoint.revision).toBe(overview.revision);

      const advanced = await domain.advance(
        overview.episodeId,
        { target: "next_game" },
        {
          expectedRevision: overview.revision,
          idempotencyKey: "real-engine-advance-0001",
        },
      );
      expect(advanced.revision).toBe(overview.revision + 1);
      expect(
        advanced.events.some((event) => event.type === "advance_complete"),
      ).toBe(true);

      const restored = await domain.restoreCheckpoint(
        overview.episodeId,
        checkpoint.checkpointId,
        {
          expectedRevision: advanced.revision,
          idempotencyKey: "real-engine-restore-0001",
        },
      );
      expect(restored.revision).toBe(advanced.revision + 1);
      const restoredState = await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      });
      expect(restoredState.revision).toBe(restored.revision);

      const ended = await domain.endEpisode(overview.episodeId, {
        exportFinalSnapshot: false,
      });
      expect(ended.finalState.status).toBe("ended");
    },
  );

  test(
    "the same seed and action sequence produces identical state hashes across two concurrent real episodes",
    { timeout: 180_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-det-test-"),
      );
      dataRoots.push(dataRoot);
      const runOnce = async (): Promise<string[]> => {
        const episodes = new EpisodeManager(
          () => new BasketballGmEngine(),
          dataRoot,
        );
        const domain = new DomainService(
          episodes,
          createFileSnapshotStore(dataRoot),
        );
        domains.push(domain);
        const hashes: string[] = [];
        const overview = await domain.createEpisode({
          scenarioId: "real-engine-determinism-test",
          seed: "real-engine-determinism-seed",
          userTeamId: 0,
          startingSeason: new Date().getFullYear(),
        });
        hashes.push(overview.stateHash);
        const result = await domain.advance(
          overview.episodeId,
          { target: "next_game" },
          {
            expectedRevision: overview.revision,
            idempotencyKey: "real-engine-det-0001",
          },
        );
        hashes.push(result.stateHash);
        return hashes;
      };

      const [a, b] = await Promise.all([runOnce(), runOnce()]);
      expect(a).toEqual(b);
    },
  );
});
