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
    "exercises every remaining mutation (roster view of another team, lineup, release, sign, contract negotiation, a real accepted trade, and a real draft pick) against the real engine",
    { timeout: 240_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-full-test-"),
      );
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

      let overview = await domain.createEpisode({
        scenarioId: "real-engine-full-coverage-test",
        seed: "real-engine-full-coverage-seed",
        userTeamId: 0,
        startingSeason: new Date().getFullYear(),
      });
      let revision = overview.revision;
      const nextKey = (label: string): string =>
        `real-full-${label}-${revision}`;

      // -- getTeamRoster: an agent must be able to see a prospective trade partner's assets --
      const otherTid = (overview.userTeam.tid + 1) % 30;
      const otherRoster = await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
        teamId: otherTid,
      });
      if (otherRoster.view !== "roster")
        throw new Error("expected roster view");
      expect(otherRoster.teamId).toBe(otherTid);
      expect(otherRoster.players.length).toBeGreaterThan(0);

      const ownRoster = await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
      });
      if (ownRoster.view !== "roster") throw new Error("expected roster view");
      expect(ownRoster.teamId).toBe(overview.userTeam.tid);
      const ownPids = ownRoster.players.map((p) => p.pid);
      expect(
        otherRoster.players
          .map((p) => p.pid)
          .some((pid) => ownPids.includes(pid)),
      ).toBe(false);

      // -- setLineup --
      const reversedOrder = [...ownPids].reverse();
      const lineupResult = await domain.setLineup(
        overview.episodeId,
        { order: reversedOrder },
        { expectedRevision: revision, idempotencyKey: nextKey("lineup") },
      );
      revision = lineupResult.revision;
      expect(lineupResult.events.some((e) => e.type === "lineup_set")).toBe(
        true,
      );

      // -- releasePlayer: release the worst-overall rostered player, keeping well above the roster minimum --
      const worst = [...ownRoster.players].sort(
        (a, b) => a.overall - b.overall,
      )[0];
      if (!worst)
        throw new Error("expected at least one rostered player to release");
      const releaseResult = await domain.releasePlayer(
        overview.episodeId,
        { pid: worst.pid },
        { expectedRevision: revision, idempotencyKey: nextKey("release") },
      );
      revision = releaseResult.revision;
      expect(releaseResult.events.some((e) => e.type === "release")).toBe(true);

      // -- signFreeAgent --
      const freeAgents = await domain.getState({
        episodeId: overview.episodeId,
        view: "free_agents",
        limit: 1,
      });
      if (freeAgents.view !== "free_agents")
        throw new Error("expected free_agents view");
      const freeAgent = freeAgents.players[0];
      if (!freeAgent)
        throw new Error("expected at least one free agent to sign");
      // zengm's default minContract is $1.2M -- signing above the minimum salary is illegal for a team
      // already over the salary cap (confirmed live: the sample league here starts well over the cap), so
      // this always signs at the minimum rather than guessing a value that happens to fit under the cap.
      const MIN_CONTRACT_AMOUNT = 1.2;
      const signResult = await domain.signFreeAgent(
        overview.episodeId,
        { pid: freeAgent.pid, amount: MIN_CONTRACT_AMOUNT, years: 2 },
        { expectedRevision: revision, idempotencyKey: nextKey("sign") },
      );
      revision = signResult.revision;
      expect(signResult.events.some((e) => e.type === "sign")).toBe(true);

      // -- negotiateContract: extend a currently-rostered player (not a free agent) -- the one path with no
      // clean real-zengm equivalent, see compatibility.ts "negotiateContract". Confirm it doesn't throw and
      // the resulting contract is actually reflected in state.
      const rosterAfterSign = await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
      });
      if (rosterAfterSign.view !== "roster")
        throw new Error("expected roster view");
      const toExtend = rosterAfterSign.players.find(
        (p) => p.pid !== freeAgent.pid,
      );
      if (!toExtend) throw new Error("expected a rostered player to extend");
      const extendedAmount = Math.max(
        1,
        Math.min(toExtend.contractAmount + 1, 20),
      );
      const negotiateResult = await domain.negotiateContract(
        overview.episodeId,
        { pid: toExtend.pid, amount: extendedAmount, years: 3 },
        { expectedRevision: revision, idempotencyKey: nextKey("negotiate") },
      );
      revision = negotiateResult.revision;
      expect(
        negotiateResult.events.some((e) => e.type === "contract_extension"),
      ).toBe(true);
      const rosterAfterNegotiate = await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
      });
      if (rosterAfterNegotiate.view !== "roster")
        throw new Error("expected roster view");
      const extendedPlayer = rosterAfterNegotiate.players.find(
        (p) => p.pid === toExtend.pid,
      );
      expect(extendedPlayer?.contractAmount).toBeCloseTo(extendedAmount, 1);

      // -- executeTrade: give away a bench player for nothing -- unambiguously favorable to the other side,
      // so a rational real trade AI should accept it. Tries a couple of partners defensively.
      let traded = false;
      const rosterForTrade = await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
      });
      if (rosterForTrade.view !== "roster")
        throw new Error("expected roster view");
      const giveaway = [...rosterForTrade.players].sort(
        (a, b) => a.overall - b.overall,
      )[0];
      if (!giveaway) throw new Error("expected a rostered player to offer");
      for (const candidateTid of [
        otherTid,
        (otherTid + 1) % 30,
        (otherTid + 2) % 30,
      ]) {
        const proposal = {
          otherTeamId: candidateTid,
          offered: [{ type: "player" as const, pid: giveaway.pid }],
          requested: [],
        };
        const evaluation = await domain.evaluateTrade(
          overview.episodeId,
          proposal,
        );
        if (evaluation.legal && evaluation.acceptedByOtherTeam === true) {
          const tradeResult = await domain.executeTrade(
            overview.episodeId,
            proposal,
            { expectedRevision: revision, idempotencyKey: nextKey("trade") },
          );
          revision = tradeResult.revision;
          expect(tradeResult.events.some((e) => e.type === "trade")).toBe(true);
          traded = true;
          break;
        }
      }
      expect(
        traded,
        "expected at least one candidate trade partner to accept a free player",
      ).toBe(true);

      // -- advance until it's genuinely the user's turn to pick. Being in the "draft" phase is necessary but
      // not sufficient -- other teams may still have picks ahead of the user's in draft order, so this
      // checks the advance_complete stop reason (blocked_pending_decision), not just the phase name.
      let phaseSteps = 0;
      let blockedOnDraftPick = false;
      while (!blockedOnDraftPick && phaseSteps < 20) {
        const result = await domain.advance(
          overview.episodeId,
          { target: "phase" },
          {
            expectedRevision: revision,
            idempotencyKey: nextKey(`phase-${phaseSteps}`),
          },
        );
        revision = result.revision;
        phaseSteps += 1;
        blockedOnDraftPick = result.events.some(
          (e) =>
            e.type === "advance_complete" &&
            e["reason"] === "blocked_pending_decision",
        );
        overview = (await domain.getState({
          episodeId: overview.episodeId,
          view: "overview",
        })) as typeof overview;
      }
      expect(blockedOnDraftPick).toBe(true);
      expect(overview.phase).toBe("draft");

      // -- makeDraftPick --
      const draft = await domain.getState({
        episodeId: overview.episodeId,
        view: "draft",
      });
      if (draft.view !== "draft") throw new Error("expected draft view");
      const prospect = draft.prospects[0];
      if (!prospect)
        throw new Error(
          "expected at least one available prospect at the draft",
        );
      const draftResult = await domain.makeDraftPick(
        overview.episodeId,
        { pid: prospect.pid },
        { expectedRevision: revision, idempotencyKey: nextKey("draft") },
      );
      revision = draftResult.revision;
      expect(draftResult.events.some((e) => e.type === "draft")).toBe(true);

      const ended = await domain.endEpisode(overview.episodeId, {
        exportFinalSnapshot: false,
      });
      expect(ended.terminalMetrics.transactionCount).toBeGreaterThanOrEqual(4); // release, sign, contract_extension, trade, draft
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
