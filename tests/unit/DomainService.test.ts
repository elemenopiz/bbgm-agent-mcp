import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import { DomainError } from "../../src/domain/errors.js";
import type {
  DraftView,
  MutationResult,
  OverviewView,
} from "../../src/domain/types.js";
import {
  DEFAULT_ALLOWED_ACTIONS,
  DEFAULT_ALLOWED_INFORMATION,
} from "../../src/domain/types.js";
import { attemptLogPathFor } from "../../src/persistence/attemptLog.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { trajectoryPathFor } from "../../src/persistence/trajectoryLog.js";
import { readAttempts, readTrajectory } from "../../src/research/trajectory.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { FakeSimulationEngine } from "../fixtures/FakeSimulationEngine.js";

class NonMutatingFreeAgentRejectionEngine extends FakeSimulationEngine {
  importCount = 0;

  override async signFreeAgent(
    input: Parameters<FakeSimulationEngine["signFreeAgent"]>[0],
  ): Promise<never> {
    throw new DomainError(
      "ILLEGAL_ACTION",
      `Player ${input.pid} refuses this offer`,
      {
        rollbackRequired: false,
        details: { pid: input.pid, reason: "test_preflight_rejection" },
      },
    );
  }

  override async importSnapshot(snapshot: unknown): Promise<void> {
    this.importCount += 1;
    await super.importSnapshot(snapshot);
  }
}

class MutatingThenFailingReleaseEngine extends FakeSimulationEngine {
  override async releasePlayer(
    input: Parameters<FakeSimulationEngine["releasePlayer"]>[0],
  ): Promise<never> {
    await super.releasePlayer(input);
    throw new DomainError(
      "ENGINE_ERROR",
      "engine failed after mutating release state",
    );
  }
}

let dataRoot: string;
let domain: DomainService;
let episodes: EpisodeManager;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "bbgm-domain-test-"));
  episodes = new EpisodeManager(() => new FakeSimulationEngine(), dataRoot);
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

const advanceUntilResigning = async (
  episodeId: string,
  revision: number,
): Promise<number> => {
  let currentRevision = revision;
  for (let i = 0; i < 30; i += 1) {
    const overview = (await domain.getState({
      episodeId,
      view: "overview",
    })) as OverviewView;
    if (overview.phase === "resigning") return currentRevision;

    if (overview.phase === "draft") {
      const options = await domain.getOptions(episodeId);
      if (options.options.some((option) => option.type === "make_draft_pick")) {
        const draft = (await domain.getState({
          episodeId,
          view: "draft",
        })) as DraftView;
        const prospect = draft.prospects[0];
        if (!prospect) throw new Error("expected a draft prospect");
        const result = await domain.makeDraftPick(
          episodeId,
          { pid: prospect.pid },
          {
            expectedRevision: currentRevision,
            idempotencyKey: `resigning-draft-${i}`,
          },
        );
        currentRevision = result.revision;
        continue;
      }
    }

    const result = await domain.advance(
      episodeId,
      { target: "phase" },
      {
        expectedRevision: currentRevision,
        idempotencyKey: `resigning-phase-${i}`,
      },
    );
    currentRevision = result.revision;
  }
  throw new Error("did not reach the resigning phase in time");
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

  test("rejects a hard constraint with no registered evaluator", async () => {
    await expect(
      domain.createEpisode({
        scenarioId: "unsupported-constraint",
        seed: "1",
        userTeamId: 0,
        startingSeason: 2026,
        constraints: {
          hard: [{ code: "WIN_A_CHAMPIONSHIP", description: "Win it all" }],
          soft: [],
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONSTRAINT" });
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
      "trading_block",
      "trade_proposals",
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

  test("draft view exposes the complete current-owner pick ledger", async () => {
    const overview = await createEpisode();
    const result = await domain.getState({
      episodeId: overview.episodeId,
      view: "draft",
    });
    if (result.view !== "draft") throw new Error("expected draft view");
    expect(result.draftPicks).toHaveLength(16);
    expect(result.ownedPicks).toHaveLength(6);
    expect(
      result.draftPicks.filter(
        (pick) => pick.currentTeamId !== overview.userTeam.tid,
      ),
    ).toHaveLength(10);
    expect(result.draftPicks).toEqual(
      [...result.draftPicks].sort(
        (a, b) => a.season - b.season || a.round - b.round || a.dpid - b.dpid,
      ),
    );
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

describe("DomainService trading block / trade proposals", () => {
  test("trading_block view starts with nothing advertised but a populated tradableRoster/tradablePicks", async () => {
    const overview = await createEpisode();
    const result = await domain.getState({
      episodeId: overview.episodeId,
      view: "trading_block",
    });
    if (result.view !== "trading_block")
      throw new Error("expected trading_block view");
    expect(result.advertisedPids).toEqual([]);
    expect(result.advertisedDpids).toEqual([]);
    expect(result.offers).toEqual([]);
    expect(result.tradableRoster).toHaveLength(12);
    expect(result.tradablePicks).toHaveLength(6);
    for (const asset of result.tradableRoster)
      expect(asset.type).toBe("player");
    for (const asset of result.tradablePicks)
      expect(asset.type).toBe("draft_pick");
  });

  test("trade_proposals view returns AI-initiated offers oriented like a TradeProposal", async () => {
    const overview = await createEpisode();
    const result = await domain.getState({
      episodeId: overview.episodeId,
      view: "trade_proposals",
    });
    if (result.view !== "trade_proposals")
      throw new Error("expected trade_proposals view");
    expect(result.offers.length).toBeGreaterThan(0);
    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    const ownedPids = new Set(roster.players.map((p) => p.pid));
    for (const offer of result.offers) {
      expect(offer.offered.length).toBeGreaterThan(0);
      expect(offer.requested.length).toBeGreaterThan(0);
      for (const asset of offer.offered) {
        if (asset.type === "player")
          expect(ownedPids.has(asset.pid)).toBe(true);
      }
      for (const asset of offer.requested) {
        if (asset.type === "player")
          expect(ownedPids.has(asset.pid)).toBe(false);
      }
    }
  });

  test("advertising a player is reflected on the trading block and generates offers", async () => {
    const overview = await createEpisode();
    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    const target = roster.players[0]!;

    const result = await domain.advertiseOnTradingBlock(
      overview.episodeId,
      { pids: [target.pid], dpids: [] },
      { expectedRevision: 0, idempotencyKey: "advertise-1" },
    );
    expect(result.revision).toBe(1);
    expect(result.events).toHaveLength(1);
    const [advertisedEvent] = result.events;
    expect(advertisedEvent?.type).toBe("trading_block_advertised");
    expect(advertisedEvent?.["pids"]).toEqual([target.pid]);
    expect(advertisedEvent?.["dpids"]).toEqual([]);
    expect(typeof advertisedEvent?.["offerCount"]).toBe("number");

    const block = await domain.getState({
      episodeId: overview.episodeId,
      view: "trading_block",
    });
    if (block.view !== "trading_block")
      throw new Error("expected trading_block view");
    expect(block.advertisedPids).toEqual([target.pid]);
    expect(block.advertisedDpids).toEqual([]);
    expect(block.offers.length).toBeGreaterThan(0);
    for (const offer of block.offers) {
      expect(offer.willing).toBe(true);
      expect(
        offer.offered.some(
          (asset) => asset.type === "player" && asset.pid === target.pid,
        ),
      ).toBe(true);
    }
  });

  test("advertising an unowned player is rejected without changing state", async () => {
    const overview = await createEpisode();
    await expect(
      domain.advertiseOnTradingBlock(
        overview.episodeId,
        { pids: [999_999], dpids: [] },
        { expectedRevision: 0, idempotencyKey: "advertise-bad" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
    const overviewAfter = (await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    })) as OverviewView;
    expect(overviewAfter.revision).toBe(0);
  });

  test("advertising with a stale expectedRevision is rejected", async () => {
    const overview = await createEpisode();
    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    const target = roster.players[0]!;

    await domain.advertiseOnTradingBlock(
      overview.episodeId,
      { pids: [target.pid], dpids: [] },
      { expectedRevision: 0, idempotencyKey: "advertise-stale-1" },
    );
    await expect(
      domain.advertiseOnTradingBlock(
        overview.episodeId,
        { pids: [target.pid], dpids: [] },
        { expectedRevision: 0, idempotencyKey: "advertise-stale-2" },
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      retryable: true,
      details: { expectedRevision: 0, currentRevision: 1 },
    });
  });

  test("rejects when the scenario does not allow the trading_block/trade_proposals information channels", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "test",
      seed: "1",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: ["overview", "roster"],
        allowedActions: [...DEFAULT_ALLOWED_ACTIONS],
      },
    });
    await expect(
      domain.getState({ episodeId: overview.episodeId, view: "trading_block" }),
    ).rejects.toMatchObject({ code: "INFORMATION_NOT_ALLOWED" });
    await expect(
      domain.getState({
        episodeId: overview.episodeId,
        view: "trade_proposals",
      }),
    ).rejects.toMatchObject({ code: "INFORMATION_NOT_ALLOWED" });
  });

  test("rejects the advertise action when the scenario does not allow it", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "test",
      seed: "1",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: [...DEFAULT_ALLOWED_INFORMATION],
        allowedActions: ["evaluate_trade", "execute_trade"],
      },
    });
    await expect(
      domain.advertiseOnTradingBlock(
        overview.episodeId,
        { pids: [], dpids: [] },
        { expectedRevision: 0, idempotencyKey: "advertise-forbidden" },
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
  });
});

describe("DomainService.getPlayer", () => {
  test("returns deep detail for a roster player, including a ratings/stats history row", async () => {
    const overview = await createEpisode();
    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    const target = roster.players[0]!;

    const result = await domain.getPlayer({
      episodeId: overview.episodeId,
      pid: target.pid,
    });

    expect(result.episodeId).toBe(overview.episodeId);
    expect(result.player.pid).toBe(target.pid);
    expect(result.player.name).toBe(target.name);
    expect(result.player.ratingsHistory.length).toBeGreaterThan(0);
    expect(result.player.ratingsHistory[0]?.overall).toBe(target.overall);
    expect(result.player.statsHistory.length).toBeGreaterThan(0);
    expect(result.player.contractSchedule.length).toBeGreaterThan(0);
    expect(result.player.contractAmount).toBe(target.contractAmount);
    // The internal composite valuation must never be exposed.
    expect(result.player).not.toHaveProperty("value");
  });

  test("returns a mostly-empty PlayerDetail for an unknown pid instead of throwing", async () => {
    const overview = await createEpisode();
    const result = await domain.getPlayer({
      episodeId: overview.episodeId,
      pid: 999_999,
    });
    expect(result.player).toEqual({
      pid: 999_999,
      ratingsHistory: [],
      statsHistory: [],
      contractSchedule: [],
      awards: [],
      injuryHistory: [],
    });
  });

  test("rejects when the scenario does not allow the player_detail information channel", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "test",
      seed: "1",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: ["overview", "roster"],
        allowedActions: [...DEFAULT_ALLOWED_ACTIONS],
      },
    });
    await expect(
      domain.getPlayer({ episodeId: overview.episodeId, pid: 1 }),
    ).rejects.toMatchObject({ code: "INFORMATION_NOT_ALLOWED" });
  });
});

describe("DomainService mutation safety", () => {
  test("enforces scenario information, action, and step restrictions", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "restricted",
      seed: "restricted-seed",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: ["overview", "options"],
        allowedActions: ["advance"],
        maxSteps: 1,
      },
    });
    expect(overview.legalActionCategories).toContain("advance");
    expect(overview.legalActionCategories).not.toContain("release_player");
    expect((await domain.getOptions(overview.episodeId)).options).toEqual([
      { type: "advance", target: "next_game" },
      { type: "advance", target: "next_decision" },
    ]);

    await expect(
      domain.getState({ episodeId: overview.episodeId, view: "roster" }),
    ).rejects.toMatchObject({ code: "INFORMATION_NOT_ALLOWED" });
    await expect(
      domain.releasePlayer(
        overview.episodeId,
        { pid: 1 },
        { expectedRevision: 0, idempotencyKey: "disallowed-1" },
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });

    await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      { expectedRevision: 0, idempotencyKey: "allowed-1" },
    );
    await expect(
      domain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: 1, idempotencyKey: "over-budget" },
      ),
    ).rejects.toMatchObject({ code: "STEP_LIMIT" });
  });

  test("enforces a scenario's fine-grained advance target allowlist", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "milestone-only",
      seed: "milestone-only-seed",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: ["overview", "options"],
        allowedActions: ["advance"],
        allowedAdvanceTargets: ["until_trade_deadline"],
      },
    });

    expect((await domain.getOptions(overview.episodeId)).options).toEqual([
      { type: "advance", target: "until_trade_deadline" },
    ]);
    await expect(
      domain.advance(
        overview.episodeId,
        { target: "next_decision" },
        { expectedRevision: 0, idempotencyKey: "blocked-target-1" },
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
  });

  test("permits an action-free scenario for an observation-only ablation", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "observation-only",
      seed: "observation-seed",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: ["overview"],
        allowedActions: [],
      },
    });
    await expect(
      domain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: 0, idempotencyKey: "observation-action-1" },
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
  });

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

  test("concurrent retries replay without consuming another step", async () => {
    const overview = await domain.createEpisode({
      scenarioId: "retry-budget",
      seed: "retry-budget-seed",
      userTeamId: 0,
      startingSeason: 2026,
      scenarioPolicy: {
        allowedInformation: [...DEFAULT_ALLOWED_INFORMATION],
        allowedActions: [...DEFAULT_ALLOWED_ACTIONS],
        maxSteps: 1,
      },
    });
    const context = { expectedRevision: 0, idempotencyKey: "same-key-02" };
    const [first, second] = await Promise.all([
      domain.advance(overview.episodeId, { target: "next_game" }, context),
      domain.advance(overview.episodeId, { target: "next_game" }, context),
    ]);
    expect(second).toEqual(first);
    expect(
      (
        (await domain.getState({
          episodeId: overview.episodeId,
          view: "overview",
        })) as OverviewView
      ).revision,
    ).toBe(1);
  });

  test("rejects reusing an idempotencyKey for a different mutation", async () => {
    const overview = await createEpisode();
    await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      { expectedRevision: 0, idempotencyKey: "same-key-01" },
    );

    await expect(
      domain.advance(
        overview.episodeId,
        { target: "games", count: 1 },
        { expectedRevision: 0, idempotencyKey: "same-key-01" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("persists accepted, rejected, and idempotent-replay attempts", async () => {
    const overview = await createEpisode();
    await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      { expectedRevision: 0, idempotencyKey: "audit-key-01" },
    );
    await expect(
      domain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: 0, idempotencyKey: "audit-stale-1" },
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      { expectedRevision: 0, idempotencyKey: "audit-key-01" },
    );

    await domain.closeAll();
    const attempts = await readAttempts(
      attemptLogPathFor(dataRoot, overview.episodeId),
    );
    expect(
      attempts.some(
        (attempt) =>
          attempt.outcome === "accepted" &&
          attempt.operation === "bbgm_advance",
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) =>
          attempt.outcome === "rejected" &&
          attempt.outcomeCode === "REVISION_CONFLICT",
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) =>
          attempt.outcome === "idempotent_replay" &&
          attempt.idempotencyKey === "audit-key-01",
      ),
    ).toBe(true);
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

  test("does not re-import a snapshot for a non-mutating engine rejection", async () => {
    await domain.closeAll();
    let rejectionEngine: NonMutatingFreeAgentRejectionEngine | undefined;
    episodes = new EpisodeManager(() => {
      rejectionEngine = new NonMutatingFreeAgentRejectionEngine();
      return rejectionEngine;
    }, dataRoot);
    domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));

    const overview = await createEpisode();
    const freeAgents = await domain.getState({
      episodeId: overview.episodeId,
      view: "free_agents",
    });
    if (freeAgents.view !== "free_agents")
      throw new Error("expected free_agents view");
    const freeAgent = freeAgents.players[0];
    if (!freeAgent) throw new Error("expected a free agent");

    await expect(
      domain.signFreeAgent(
        overview.episodeId,
        { pid: freeAgent.pid, amount: 5, years: 2 },
        { expectedRevision: 0, idempotencyKey: "safe-refusal" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
    expect(rejectionEngine?.importCount).toBe(0);
  });

  test("writes an explicit rollback trajectory node for a mutating rejection", async () => {
    await domain.closeAll();
    episodes = new EpisodeManager(
      () => new MutatingThenFailingReleaseEngine(),
      dataRoot,
    );
    domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));

    const overview = await createEpisode();
    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    const player = roster.players[0];
    if (!player) throw new Error("expected a roster player");

    await expect(
      domain.releasePlayer(
        overview.episodeId,
        { pid: player.pid },
        { expectedRevision: 0, idempotencyKey: "rollback-audit" },
      ),
    ).rejects.toMatchObject({ code: "ENGINE_ERROR" });

    await domain.closeAll();
    const trajectory = await readTrajectory(
      trajectoryPathFor(dataRoot, overview.episodeId),
    );
    const rollback = trajectory.find((record) => record.step === "rollback");
    expect(rollback).toMatchObject({
      sequence: 1,
      toolName: "bbgm_release_player",
      revision: 0,
      rollback: {
        outcomeCode: "ENGINE_ERROR",
        rollbackRequired: true,
      },
    });
    expect(rollback?.preStateHash).toBe(rollback?.postStateHash);
    expect(trajectory.map((record) => record.sequence)).toEqual([0, 1]);
  });

  test("allows resigning-window negotiation for a free agent but not release", async () => {
    const overview = await createEpisode();
    const revision = await advanceUntilResigning(overview.episodeId, 0);
    const freeAgents = await domain.getState({
      episodeId: overview.episodeId,
      view: "free_agents",
    });
    if (freeAgents.view !== "free_agents")
      throw new Error("expected free_agents view");
    const freeAgent = freeAgents.players[0];
    if (!freeAgent) throw new Error("expected a free agent");

    await expect(
      domain.releasePlayer(
        overview.episodeId,
        { pid: freeAgent.pid },
        { expectedRevision: revision, idempotencyKey: "release-free-agent" },
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });

    const result = await domain.negotiateContract(
      overview.episodeId,
      { pid: freeAgent.pid, amount: 5, years: 2 },
      { expectedRevision: revision, idempotencyKey: "resign-free-agent" },
    );
    expect(
      result.events.some((event) => event.type === "contract_extension"),
    ).toBe(true);
    expect(result.revision).toBe(revision + 1);

    const roster = await domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    });
    if (roster.view !== "roster") throw new Error("expected roster view");
    expect(roster.players.some((player) => player.pid === freeAgent.pid)).toBe(
      true,
    );
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
    const finalSnapshot = JSON.parse(
      await readFile(
        join(dataRoot, "episodes", overview.episodeId, "final-snapshot.json"),
        "utf8",
      ),
    ) as { input?: { episodeId?: string } };
    expect(finalSnapshot.input?.episodeId).toBe(overview.episodeId);

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

describe("DomainService persistence and resume", () => {
  test("can start an evaluator episode from a controlled engine snapshot", async () => {
    const source = await createEpisode("snapshot-source");
    await domain.advance(
      source.episodeId,
      { target: "games", count: 3 },
      { expectedRevision: 0, idempotencyKey: "snapshot-source-advance" },
    );
    const sourceSnapshot = await episodes
      .get(source.episodeId)
      .engine.exportSnapshot();
    const sourceState = (await domain.getState({
      episodeId: source.episodeId,
      view: "overview",
    })) as OverviewView;

    const controlled = await domain.createEpisode({
      scenarioId: "controlled-start",
      seed: "controlled-seed",
      userTeamId: 0,
      startingSeason: 2026,
      initialSnapshot: sourceSnapshot,
    });
    expect(controlled.season).toBe(sourceState.season);
    expect(controlled.phase).toBe(sourceState.phase);
    expect(controlled.userTeam.won + controlled.userTeam.lost).toBe(
      sourceState.userTeam.won + sourceState.userTeam.lost,
    );

    const metadata = JSON.parse(
      await readFile(
        join(dataRoot, "episodes", controlled.episodeId, "metadata.json"),
        "utf8",
      ),
    ) as { initialSnapshotHash?: string };
    expect(metadata.initialSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("resumes an active episode with its revision and idempotency history", async () => {
    const overview = await createEpisode("resume-seed");
    await domain.advance(
      overview.episodeId,
      { target: "next_game" },
      { expectedRevision: 0, idempotencyKey: "resume-key-01" },
    );
    await episodes.closeAll();

    const resumedManager = new EpisodeManager(
      () => new FakeSimulationEngine(),
      dataRoot,
    );
    const resumedDomain = new DomainService(
      resumedManager,
      createFileSnapshotStore(dataRoot),
    );
    try {
      const resumed = await resumedDomain.resumeEpisode(overview.episodeId);
      expect(resumed.revision).toBe(1);

      const replayed = await resumedDomain.advance(
        overview.episodeId,
        { target: "next_game" },
        { expectedRevision: 0, idempotencyKey: "resume-key-01" },
      );
      expect(replayed.revision).toBe(1);
    } finally {
      await resumedDomain.closeAll();
    }
  });

  test("can recover a quarantined episode after the worker is replaced", async () => {
    const overview = await createEpisode("quarantine-seed");
    const record = episodes.get(overview.episodeId);
    record.status = "quarantined";
    await episodes.persist(record);
    await episodes.closeAll();

    const resumedManager = new EpisodeManager(
      () => new FakeSimulationEngine(),
      dataRoot,
    );
    const resumedDomain = new DomainService(
      resumedManager,
      createFileSnapshotStore(dataRoot),
    );
    try {
      const resumed = await resumedDomain.resumeEpisode(overview.episodeId);
      expect(resumed.status).toBe("active");
    } finally {
      await resumedDomain.closeAll();
    }
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
