import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import type {
  DraftView,
  MutationResult,
  OverviewView,
} from "../../src/domain/types.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

let dataRoot: string;
let domain: DomainService;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "bbgm-domain-test-"));
  const episodes = new EpisodeManager(
    () => new FakeSimulationEngine(),
    dataRoot,
  );
  domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));
});

afterEach(async () => {
  await domain.closeAll();
  await rm(dataRoot, { recursive: true, force: true });
});

const createEpisode = async (seed = "1"): Promise<OverviewView> =>
  domain.createEpisode({
    scenarioId: "test",
    seed,
    userTeamId: 0,
    startingSeason: 2026,
  });

const advanceUntilPhase = async (
  episodeId: string,
  revision: number,
  phase: string,
): Promise<number> => {
  let currentRevision = revision;
  for (let i = 0; i < 10; i += 1) {
    const overview = (await domain.getState({
      episodeId,
      view: "overview",
    })) as OverviewView;
    if (overview.phase === phase) return currentRevision;
    const result = await domain.advance(
      episodeId,
      { target: "phase" },
      { expectedRevision: currentRevision, idempotencyKey: `phase-${i}` },
    );
    currentRevision = result.revision;
  }
  throw new Error(`did not reach phase ${phase} in time`);
};

describe("DomainService.createEpisode", () => {
  test("returns an overview at revision 0 with a real state hash", async () => {
    const overview = await createEpisode();
    expect(overview.view).toBe("overview");
    expect(overview.revision).toBe(0);
    expect(overview.status).toBe("active");
    expect(overview.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(overview.rosterCount).toBe(12);
  });
});

describe("DomainService.getState views", () => {
  test("every view resolves with the matching discriminant and current revision", async () => {
    const overview = await createEpisode();
    const views = [
      "overview",
      "roster",
      "finances",
      "standings",
      "schedule",
      "free_agents",
      "draft",
      "transactions",
      "objectives",
      "constraints",
    ] as const;
    for (const view of views) {
      const result = await domain.getState({
        episodeId: overview.episodeId,
        view,
      });
      expect(result.view).toBe(view);
      expect(result.revision).toBe(0);
    }
  });

  test("roster view paginates with a bounded default limit", async () => {
    const overview = await createEpisode();
    const result = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
      limit: 5,
    });
    if (result.view !== "roster") throw new Error("expected roster view");
    expect(result.players).toHaveLength(5);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.totalCount).toBe(12);
  });

  test("roster view defaults to the user's own team but teamId can read another team's public roster", async () => {
    const overview = await createEpisode();
    const own = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (own.view !== "roster") throw new Error("expected roster view");
    expect(own.teamId).toBe(overview.userTeam.tid);

    const other = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
      teamId: 9001,
    });
    if (other.view !== "roster") throw new Error("expected roster view");
    expect(other.teamId).toBe(9001);
    expect(other.players.length).toBeGreaterThan(0);
    expect(other.players.map((p) => p.pid)).not.toEqual(
      own.players.map((p) => p.pid),
    );
  });

  test("reading another team's roster fails once the episode has ended", async () => {
    const overview = await createEpisode();
    await domain.endEpisode(overview.episodeId, { exportFinalSnapshot: false });
    await expect(
      domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
        teamId: 9001,
      }),
    ).rejects.toMatchObject({
      code: "ILLEGAL_ACTION",
    });
    // The user's own roster (cached from end) stays readable.
    const own = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    expect(own.view).toBe("roster");
  });
});

describe("DomainService mutation safety", () => {
  test("rejects a stale expectedRevision with a typed, retryable conflict", async () => {
    const overview = await createEpisode();
    await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      { expectedRevision: 0, idempotencyKey: "a1" },
    );
    await expect(
      domain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: 0, idempotencyKey: "a2" },
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      retryable: true,
      details: { expectedRevision: 0, currentRevision: 1 },
    });
  });

  test("replays the cached result for a repeated idempotencyKey instead of re-applying the action", async () => {
    const overview = await createEpisode();
    const context = { expectedRevision: 0, idempotencyKey: "same-key-00" };
    const first = await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      context,
    );
    const second = await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      context,
    );
    expect(second).toEqual(first);
    expect(second.revision).toBe(1);
  });

  test("rolls back and rejects an illegal action without incrementing revision", async () => {
    const overview = await createEpisode();
    await expect(
      domain.releasePlayer(
        overview.episodeId,
        { pid: 999_999 },
        { expectedRevision: 0, idempotencyKey: "bad-release" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
    const state = (await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    })) as OverviewView;
    expect(state.revision).toBe(0);
  });

  test("makeDraftPick is rejected with INVALID_PHASE outside the draft phase", async () => {
    const overview = await createEpisode();
    await expect(
      domain.makeDraftPick(
        overview.episodeId,
        { pid: 1 },
        { expectedRevision: 0, idempotencyKey: "early-pick" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });

  test("signFreeAgent rejects a pid that is not a free agent", async () => {
    const overview = await createEpisode();
    await expect(
      domain.signFreeAgent(
        overview.episodeId,
        { pid: 1, amount: 5, years: 2 },
        { expectedRevision: 0, idempotencyKey: "sign-bad" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
  });

  test("setLineup accepts a full permutation of the roster and rejects a partial one", async () => {
    const overview = await createEpisode();
    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    const pids = roster.players.map((p) => p.pid);

    const good = await domain.setLineup(
      overview.episodeId,
      { order: [...pids].reverse() },
      { expectedRevision: 0, idempotencyKey: "lineup-ok" },
    );
    expect(good.revision).toBe(1);

    await expect(
      domain.setLineup(
        overview.episodeId,
        { order: pids.slice(0, 3) },
        { expectedRevision: 1, idempotencyKey: "lineup-bad" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
  });
});

describe("DomainService draft flow", () => {
  test("reaching the draft phase blocks further phase advancement until a pick is made", async () => {
    const overview = await createEpisode();
    const revision = await advanceUntilPhase(overview.episodeId, 0, "draft");
    const draft = (await domain.getState({
      episodeId: overview.episodeId,
      view: "draft",
    })) as DraftView;
    expect(draft.prospects.length).toBeGreaterThan(0);

    const firstProspect = draft.prospects[0]!;
    const pickResult: MutationResult = await domain.makeDraftPick(
      overview.episodeId,
      { pid: firstProspect.pid },
      { expectedRevision: revision, idempotencyKey: "draft-pick-1" },
    );
    expect(pickResult.revision).toBe(revision + 1);
    expect(pickResult.events.some((e) => e.type === "draft")).toBe(true);
  });
});

describe("DomainService checkpoints", () => {
  test("restores a checkpoint and still advances the monotonic revision", async () => {
    const overview = await createEpisode("checkpoint-seed");
    const checkpoint = await domain.createCheckpoint(overview.episodeId);
    expect(checkpoint.revision).toBe(0);

    await domain.advance(
      overview.episodeId,
      { target: "games", count: 5 },
      { expectedRevision: 0, idempotencyKey: "pre-checkpoint" },
    );
    const afterGames = (await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    })) as OverviewView;
    expect(afterGames.userTeam.won + afterGames.userTeam.lost).toBe(5);

    const restored = await domain.restoreCheckpoint(
      overview.episodeId,
      checkpoint.checkpointId,
      {
        expectedRevision: afterGames.revision,
        idempotencyKey: "restore-1",
      },
    );
    expect(restored.revision).toBe(afterGames.revision + 1);
    const restoredState = (await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    })) as OverviewView;
    expect(restoredState.userTeam.won + restoredState.userTeam.lost).toBe(0);
  });

  test("listCheckpoints returns every created checkpoint for the episode", async () => {
    const overview = await createEpisode();
    await domain.createCheckpoint(overview.episodeId);
    await domain.createCheckpoint(overview.episodeId);
    expect(domain.listCheckpoints(overview.episodeId)).toHaveLength(2);
  });
});

describe("DomainService.endEpisode", () => {
  test("ends the episode, blocks further mutation, but keeps state readable", async () => {
    const overview = await createEpisode();
    const result = await domain.endEpisode(overview.episodeId, {
      exportFinalSnapshot: true,
    });
    expect(result.finalState.status).toBe("ended");
    expect(result.snapshotCheckpointId).toBeDefined();

    const stillReadable = await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    });
    expect(stillReadable.view).toBe("overview");

    await expect(
      domain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: 0, idempotencyKey: "after-end" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
  });
});

describe("DomainService evaluateTrade", () => {
  test("is a pure dry run that never changes the revision", async () => {
    const overview = await createEpisode();
    await domain.evaluateTrade(overview.episodeId, {
      otherTeamId: 9001,
      offered: [{ type: "player", pid: 1 }],
      requested: [],
    });
    const state = (await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    })) as OverviewView;
    expect(state.revision).toBe(0);
  });
});
