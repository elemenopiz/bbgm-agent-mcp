import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import type { OverviewView } from "../../src/domain/types.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

const runFixedSequence = async (
  domain: DomainService,
  seed: string,
): Promise<string[]> => {
  const hashes: string[] = [];
  const overview = await domain.createEpisode({
    scenarioId: "determinism",
    seed,
    userTeamId: 0,
    startingSeason: 2026,
  });
  hashes.push(overview.stateHash);

  let revision = overview.revision;
  const actions = [
    () =>
      domain.advance(
        overview.episodeId,
        { target: "games", count: 4 },
        { expectedRevision: revision, idempotencyKey: "det-1" },
      ),
    () =>
      domain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: revision, idempotencyKey: "det-2" },
      ),
    () =>
      domain
        .evaluateTrade(overview.episodeId, {
          otherTeamId: 9001,
          offered: [],
          requested: [],
        })
        .then(() => null),
    () =>
      domain.advance(
        overview.episodeId,
        { target: "games", count: 3 },
        { expectedRevision: revision, idempotencyKey: "det-3" },
      ),
  ];

  for (const action of actions) {
    const result = await action();
    if (result) {
      revision = result.revision;
      hashes.push(result.stateHash);
    }
  }
  return hashes;
};

describe("determinism", () => {
  test("identical seed and action sequence produces an identical state hash sequence", async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), "bbgm-det-a-")),
      mkdtemp(join(tmpdir(), "bbgm-det-b-")),
    ]);
    try {
      const [domainA, domainB] = roots.map(
        (root) =>
          new DomainService(
            new EpisodeManager(() => new FakeSimulationEngine(), root),
            createFileSnapshotStore(root),
          ),
      );

      const [hashesA, hashesB] = await Promise.all([
        runFixedSequence(domainA!, "determinism-seed"),
        runFixedSequence(domainB!, "determinism-seed"),
      ]);

      expect(hashesA).toEqual(hashesB);
      expect(hashesA.length).toBeGreaterThan(1);

      await Promise.all([domainA!.closeAll(), domainB!.closeAll()]);
    } finally {
      await Promise.all(
        roots.map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  });

  test("different seeds diverge in at least one state hash", async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), "bbgm-det-c-")),
      mkdtemp(join(tmpdir(), "bbgm-det-d-")),
    ]);
    try {
      const [domainA, domainB] = roots.map(
        (root) =>
          new DomainService(
            new EpisodeManager(() => new FakeSimulationEngine(), root),
            createFileSnapshotStore(root),
          ),
      );

      const [hashesA, hashesB] = await Promise.all([
        runFixedSequence(domainA!, "seed-one"),
        runFixedSequence(domainB!, "seed-two"),
      ]);

      expect(hashesA).not.toEqual(hashesB);

      await Promise.all([domainA!.closeAll(), domainB!.closeAll()]);
    } finally {
      await Promise.all(
        roots.map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  });
});

describe("episode isolation", () => {
  test("two concurrently-running episodes with different seeds never cross-contaminate state", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "bbgm-isolation-"));
    try {
      const episodes = new EpisodeManager(
        () => new FakeSimulationEngine(),
        dataRoot,
      );
      const domain = new DomainService(
        episodes,
        createFileSnapshotStore(dataRoot),
      );

      const [a, b] = await Promise.all([
        domain.createEpisode({
          scenarioId: "iso",
          seed: "seed-a",
          userTeamId: 0,
          startingSeason: 2026,
        }),
        domain.createEpisode({
          scenarioId: "iso",
          seed: "seed-b",
          userTeamId: 0,
          startingSeason: 2026,
        }),
      ]);
      expect(a.episodeId).not.toBe(b.episodeId);

      const [advancedA, advancedB] = await Promise.all([
        domain.advance(
          a.episodeId,
          { target: "games", count: 6 },
          { expectedRevision: 0, idempotencyKey: "iso-a" },
        ),
        domain.advance(
          b.episodeId,
          { target: "games", count: 6 },
          { expectedRevision: 0, idempotencyKey: "iso-b" },
        ),
      ]);

      // Different seeds should (overwhelmingly likely) produce different win/loss outcomes or hashes.
      expect(advancedA.stateHash).not.toBe(advancedB.stateHash);

      const [stateA, stateB] = await Promise.all([
        domain.getState({
          episodeId: a.episodeId,
          view: "overview",
        }) as Promise<OverviewView>,
        domain.getState({
          episodeId: b.episodeId,
          view: "overview",
        }) as Promise<OverviewView>,
      ]);
      expect(stateA.episodeId).toBe(a.episodeId);
      expect(stateB.episodeId).toBe(b.episodeId);

      await domain.closeAll();
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
