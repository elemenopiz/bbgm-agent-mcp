import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DomainService } from "../../src/domain/DomainService.js";
import type {
  FinancesView,
  OverviewView,
  RosterView,
  TradeProposal,
} from "../../src/domain/types.js";
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

      // The checkpoint includes the worker PRNG state, not just IndexedDB.
      // Repeating the same post-checkpoint action after a second restore must
      // therefore produce the same engine state (revision/hash are expected
      // to differ because restore and advance are audited mutations).
      const firstContinuation = await domain.advance(
        overview.episodeId,
        { target: "next_game" },
        {
          expectedRevision: restored.revision,
          idempotencyKey: "real-engine-continuation-0001",
        },
      );
      const firstContinuationState = await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      });
      const restoredAgain = await domain.restoreCheckpoint(
        overview.episodeId,
        checkpoint.checkpointId,
        {
          expectedRevision: firstContinuation.revision,
          idempotencyKey: "real-engine-restore-0002",
        },
      );
      await domain.advance(
        overview.episodeId,
        { target: "next_game" },
        {
          expectedRevision: restoredAgain.revision,
          idempotencyKey: "real-engine-continuation-0002",
        },
      );
      const secondContinuationState = await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      });
      const comparable = (
        state: OverviewView,
      ): Omit<OverviewView, "episodeId" | "revision" | "stateHash"> => {
        const {
          episodeId: _episodeId,
          revision: _revision,
          stateHash: _stateHash,
          ...rest
        } = state;
        return rest;
      };
      expect(comparable(firstContinuationState as OverviewView)).toEqual(
        comparable(secondContinuationState as OverviewView),
      );

      const ended = await domain.endEpisode(overview.episodeId, {
        exportFinalSnapshot: false,
      });
      expect(ended.finalState.status).toBe("ended");
    },
  );

  test(
    "resumes a persisted real-engine snapshot in a fresh worker",
    { timeout: 180_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-resume-test-"),
      );
      dataRoots.push(dataRoot);
      const snapshots = createFileSnapshotStore(dataRoot);
      const firstManager = new EpisodeManager(
        () => new BasketballGmEngine(),
        dataRoot,
      );
      const firstDomain = new DomainService(firstManager, snapshots);
      domains.push(firstDomain);

      const created = await firstDomain.createEpisode({
        scenarioId: "real-engine-resume-test",
        seed: "real-engine-resume-seed",
        userTeamId: 0,
        startingSeason: new Date().getFullYear(),
      });
      const advanced = await firstDomain.advance(
        created.episodeId,
        { target: "next_game" },
        {
          expectedRevision: created.revision,
          idempotencyKey: "real-resume-01",
        },
      );
      await firstDomain.closeAll();

      const secondManager = new EpisodeManager(
        () => new BasketballGmEngine(),
        dataRoot,
      );
      const secondDomain = new DomainService(secondManager, snapshots);
      domains.push(secondDomain);

      const resumed = await secondDomain.resumeEpisode(created.episodeId);
      expect(resumed.revision).toBe(advanced.revision);
      expect(resumed.stateHash).toBe(advanced.stateHash);
      expect(resumed.status).toBe("active");
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

      const overview = await domain.createEpisode({
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

      const ended = await domain.endEpisode(overview.episodeId, {
        exportFinalSnapshot: false,
      });
      expect(ended.terminalMetrics.transactionCount).toBeGreaterThanOrEqual(4); // release, sign, contract_extension, trade
    },
  );

  test(
    "advertises on the trading block, reads AI trade proposals, and rejects a stale revision",
    { timeout: 180_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-trading-block-test-"),
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

      const overview = await domain.createEpisode({
        scenarioId: "real-engine-trading-block-test",
        seed: "real-engine-trading-block-seed",
        userTeamId: 0,
        startingSeason: new Date().getFullYear(),
      });

      // -- empty trading block before anything is advertised --
      const emptyBlock = await domain.getState({
        episodeId: overview.episodeId,
        view: "trading_block",
      });
      if (emptyBlock.view !== "trading_block")
        throw new Error("expected trading_block view");
      expect(emptyBlock.advertisedPids).toEqual([]);
      expect(emptyBlock.advertisedDpids).toEqual([]);
      expect(emptyBlock.offers).toEqual([]);
      expect(emptyBlock.tradableRoster.length).toBeGreaterThan(0);

      // -- AI-initiated trade proposals, independent of the trading block --
      const proposals = await domain.getState({
        episodeId: overview.episodeId,
        view: "trade_proposals",
      });
      if (proposals.view !== "trade_proposals")
        throw new Error("expected trade_proposals view");
      for (const proposalOffer of proposals.offers) {
        expect(proposalOffer.offered.length).toBeGreaterThan(0);
        expect(proposalOffer.requested.length).toBeGreaterThan(0);
        // The internal composite valuation must never be exposed.
        for (const asset of [
          ...proposalOffer.offered,
          ...proposalOffer.requested,
        ]) {
          expect(asset).not.toHaveProperty("value");
        }
      }

      // -- advertise a tradable roster player --
      const tradable = emptyBlock.tradableRoster.find(
        (asset) => asset.type === "player" && asset.untradable !== true,
      );
      if (tradable?.type !== "player")
        throw new Error("expected at least one tradable roster player");
      const advertised = await domain.advertiseOnTradingBlock(
        overview.episodeId,
        { pids: [tradable.pid], dpids: [] },
        {
          expectedRevision: overview.revision,
          idempotencyKey: "real-trading-block-advertise-0001",
        },
      );
      expect(advertised.revision).toBe(overview.revision + 1);
      expect(
        advertised.events.some(
          (event) => event.type === "trading_block_advertised",
        ),
      ).toBe(true);

      const block = await domain.getState({
        episodeId: overview.episodeId,
        view: "trading_block",
      });
      if (block.view !== "trading_block")
        throw new Error("expected trading_block view");
      expect(block.advertisedPids).toEqual([tradable.pid]);
      for (const offer of block.offers) {
        for (const asset of [...offer.offered, ...offer.requested]) {
          expect(asset).not.toHaveProperty("value");
        }
      }

      // -- a stale expectedRevision must be rejected, leaving state unchanged --
      await expect(
        domain.advertiseOnTradingBlock(
          overview.episodeId,
          { pids: [tradable.pid], dpids: [] },
          {
            expectedRevision: overview.revision,
            idempotencyKey: "real-trading-block-stale-0001",
          },
        ),
      ).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
        retryable: true,
        details: {
          expectedRevision: overview.revision,
          currentRevision: advertised.revision,
        },
      });
      const afterStaleAttempt = await domain.getState({
        episodeId: overview.episodeId,
        view: "trading_block",
      });
      if (afterStaleAttempt.view !== "trading_block")
        throw new Error("expected trading_block view");
      expect(afterStaleAttempt.advertisedPids).toEqual([tradable.pid]);
      expect(afterStaleAttempt.revision).toBe(advertised.revision);
    },
  );

  test(
    "makes a real draft pick after advancing a fresh league to the user decision",
    { timeout: 180_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-draft-test-"),
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
        scenarioId: "real-engine-draft-test",
        seed: "real-engine-draft-seed",
        userTeamId: 0,
        startingSeason: new Date().getFullYear(),
        scenarioPolicy: {
          allowedAdvanceTargets: [
            "until_regular_season",
            "until_trade_deadline",
            "until_playoffs",
            "through_playoffs",
            "until_draft",
            "until_next_pick",
          ],
        },
      });
      let revision = overview.revision;
      const milestones = [
        "until_regular_season",
        "until_trade_deadline",
        "until_playoffs",
        "through_playoffs",
        "until_draft",
        "until_next_pick",
      ] as const;
      for (const target of milestones) {
        const result = await domain.advance(
          overview.episodeId,
          { target },
          {
            expectedRevision: revision,
            idempotencyKey: `real-draft-${target}`,
          },
        );
        revision = result.revision;
        overview = (await domain.getState({
          episodeId: overview.episodeId,
          view: "overview",
        })) as OverviewView;
      }
      expect(overview.phase).toBe("draft");

      const draft = await domain.getState({
        episodeId: overview.episodeId,
        view: "draft",
      });
      if (draft.view !== "draft") throw new Error("expected draft view");
      const prospect = draft.prospects[0];
      if (!prospect) throw new Error("expected a draft prospect");
      const draftResult = await domain.makeDraftPick(
        overview.episodeId,
        { pid: prospect.pid },
        {
          expectedRevision: revision,
          idempotencyKey: "real-draft-pick-0001",
        },
      );
      expect(draftResult.events.some((event) => event.type === "draft")).toBe(
        true,
      );
      const ended = await domain.endEpisode(overview.episodeId, {
        exportFinalSnapshot: false,
      });
      expect(ended.terminalMetrics.transactionCount).toBeGreaterThanOrEqual(1);
    },
  );

  test(
    "cross-checks a legal trade declined by the real opponent and preserves state",
    { timeout: 240_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-declined-trade-test-"),
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

      const overview = await domain.createEpisode({
        scenarioId: "real-engine-declined-trade-test",
        seed: "real-engine-declined-trade-seed",
        userTeamId: 0,
        startingSeason: new Date().getFullYear(),
      });
      const ownRoster = await domain.getState({
        episodeId: overview.episodeId,
        view: "roster",
      });
      if (ownRoster.view !== "roster") throw new Error("expected roster view");

      // Search a bounded, deterministic set of deliberately bad offers. The
      // salary-compatible pair is not known in advance because the real
      // league's generated contracts vary by seed, while the opponent's
      // ValueChangeCalculator should consistently reject a low-value player
      // for a high-value player when the trade is otherwise legal.
      const offeredCandidates = [...ownRoster.players]
        .sort((a, b) => a.overall - b.overall)
        .slice(0, 8);
      let declined:
        | {
            proposal: TradeProposal;
            evaluation: Awaited<ReturnType<DomainService["evaluateTrade"]>>;
          }
        | undefined;

      for (let offset = 1; offset < 8 && declined === undefined; offset += 1) {
        const otherTeamId = (overview.userTeam.tid + offset) % 30;
        const otherRoster = await domain.getState({
          episodeId: overview.episodeId,
          view: "roster",
          teamId: otherTeamId,
        });
        if (otherRoster.view !== "roster")
          throw new Error("expected roster view");
        const requestedCandidates = [...otherRoster.players]
          .sort((a, b) => b.overall - a.overall)
          .slice(0, 8);

        for (const offered of offeredCandidates) {
          for (const requested of requestedCandidates) {
            const proposal = {
              otherTeamId,
              offered: [{ type: "player" as const, pid: offered.pid }],
              requested: [{ type: "player" as const, pid: requested.pid }],
            };
            const evaluation = await domain.evaluateTrade(
              overview.episodeId,
              proposal,
            );
            if (evaluation.legal && evaluation.acceptedByOtherTeam === false) {
              declined = { proposal, evaluation };
              break;
            }
          }
          if (declined !== undefined) break;
        }
      }

      if (declined === undefined) {
        throw new Error(
          "The pinned real engine exposed no legal trade that its opponent declined within the bounded candidate set",
        );
      }
      expect(declined.evaluation.legal).toBe(true);
      expect(declined.evaluation.acceptedByOtherTeam).toBe(false);
      expect(declined.evaluation.reasons.join(" ")).toMatch(
        /would not accept|not accept/i,
      );

      const before = (await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      })) as OverviewView;
      await expect(
        domain.executeTrade(overview.episodeId, declined.proposal, {
          expectedRevision: before.revision,
          idempotencyKey: "real-engine-declined-trade-0001",
        }),
      ).rejects.toThrow(/not executable|rejected/i);

      const after = (await domain.getState({
        episodeId: overview.episodeId,
        view: "overview",
      })) as OverviewView;
      expect(after.revision).toBe(before.revision);
      expect(after.stateHash).toBe(before.stateHash);
      expect(after.rosterCount).toBe(before.rosterCount);
      expect(after.status).toBe("active");
    },
  );

  test(
    "isolates mixed concurrent mutations across two real episode workers",
    { timeout: 240_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-concurrent-mutations-test-"),
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

      const [episodeA, episodeB] = await Promise.all([
        domain.createEpisode({
          scenarioId: "real-engine-concurrent-mutations-a",
          seed: "real-engine-concurrent-mutations-seed-a",
          userTeamId: 0,
          startingSeason: new Date().getFullYear(),
        }),
        domain.createEpisode({
          scenarioId: "real-engine-concurrent-mutations-b",
          seed: "real-engine-concurrent-mutations-seed-b",
          userTeamId: 0,
          startingSeason: new Date().getFullYear(),
        }),
      ]);
      const [rosterA, rosterB, freeAgentsA, freeAgentsB] = await Promise.all([
        domain.getState({ episodeId: episodeA.episodeId, view: "roster" }),
        domain.getState({ episodeId: episodeB.episodeId, view: "roster" }),
        domain.getState({
          episodeId: episodeA.episodeId,
          view: "free_agents",
          limit: 1,
        }),
        domain.getState({
          episodeId: episodeB.episodeId,
          view: "free_agents",
          limit: 1,
        }),
      ]);
      if (
        rosterA.view !== "roster" ||
        rosterB.view !== "roster" ||
        freeAgentsA.view !== "free_agents" ||
        freeAgentsB.view !== "free_agents"
      ) {
        throw new Error("expected roster and free-agent views");
      }
      const releaseA = rosterA.players[0];
      const releaseB = rosterB.players[0];
      const freeAgentA = freeAgentsA.players[0];
      const freeAgentB = freeAgentsB.players[0];
      const negotiateA = rosterA.players.find(
        (player) => player.pid !== releaseA?.pid,
      );
      if (!releaseA || !releaseB || !freeAgentA || !freeAgentB || !negotiateA) {
        throw new Error("expected real league roster and free-agent entries");
      }

      // Different mutation types run at the same time, but each episode's
      // own queue must still apply them in a valid revision order.
      const [lineupA, releaseResultB] = await Promise.all([
        domain.setLineup(
          episodeA.episodeId,
          { order: [...rosterA.players].reverse().map((player) => player.pid) },
          { expectedRevision: 0, idempotencyKey: "real-mixed-a-lineup-0001" },
        ),
        domain.releasePlayer(
          episodeB.episodeId,
          { pid: releaseB.pid },
          { expectedRevision: 0, idempotencyKey: "real-mixed-b-release-0001" },
        ),
      ]);
      const [releaseResultA, signResultB] = await Promise.all([
        domain.releasePlayer(
          episodeA.episodeId,
          { pid: releaseA.pid },
          {
            expectedRevision: lineupA.revision,
            idempotencyKey: "real-mixed-a-release-0001",
          },
        ),
        domain.signFreeAgent(
          episodeB.episodeId,
          { pid: freeAgentB.pid, amount: 1.2, years: 2 },
          {
            expectedRevision: releaseResultB.revision,
            idempotencyKey: "real-mixed-b-sign-0001",
          },
        ),
      ]);
      const [negotiateResultA, advanceResultB] = await Promise.all([
        domain.negotiateContract(
          episodeA.episodeId,
          {
            pid: negotiateA.pid,
            amount: Math.max(1, Math.min(negotiateA.contractAmount + 1, 20)),
            years: 3,
          },
          {
            expectedRevision: releaseResultA.revision,
            idempotencyKey: "real-mixed-a-negotiate-0001",
          },
        ),
        domain.advance(
          episodeB.episodeId,
          { target: "next_game" },
          {
            expectedRevision: signResultB.revision,
            idempotencyKey: "real-mixed-b-advance-0001",
          },
        ),
      ]);

      expect(negotiateResultA.revision).toBe(3);
      expect(advanceResultB.revision).toBe(3);
      expect(
        negotiateResultA.events.some(
          (event) => event.type === "contract_extension",
        ),
      ).toBe(true);
      expect(
        advanceResultB.events.some(
          (event) => event.type === "advance_complete",
        ),
      ).toBe(true);

      const [finalA, finalB] = (await Promise.all([
        domain.getState({ episodeId: episodeA.episodeId, view: "overview" }),
        domain.getState({ episodeId: episodeB.episodeId, view: "overview" }),
      ])) as [OverviewView, OverviewView];
      expect(finalA.episodeId).toBe(episodeA.episodeId);
      expect(finalB.episodeId).toBe(episodeB.episodeId);
      expect(finalA.revision).toBe(3);
      expect(finalB.revision).toBe(3);
      expect(finalA.rosterCount).toBe(episodeA.rosterCount - 1);
      expect(finalB.rosterCount).toBe(episodeB.rosterCount);

      const [finalRosterA, finalRosterB] = await Promise.all([
        domain.getState({ episodeId: episodeA.episodeId, view: "roster" }),
        domain.getState({ episodeId: episodeB.episodeId, view: "roster" }),
      ]);
      if (finalRosterA.view !== "roster" || finalRosterB.view !== "roster")
        throw new Error("expected final roster views");
      expect(
        finalRosterA.players.some((player) => player.pid === releaseA.pid),
      ).toBe(false);
      expect(
        finalRosterB.players.some((player) => player.pid === releaseB.pid),
      ).toBe(false);
      expect(
        finalRosterB.players.some((player) => player.pid === freeAgentB.pid),
      ).toBe(true);
      expect(
        finalRosterA.players.some((player) => player.pid === negotiateA.pid),
      ).toBe(true);
      expect(finalA.stateHash).not.toBe(finalB.stateHash);
    },
  );

  test(
    "rejects an unsupported custom league configuration before starting a real worker",
    { timeout: 30_000 },
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "bbgm-real-engine-custom-config-test-"),
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

      await expect(
        domain.createEpisode({
          scenarioId: "real-engine-unsupported-custom-config-test",
          seed: "real-engine-unsupported-custom-config-seed",
          userTeamId: 0,
          startingSeason: new Date().getFullYear(),
          // CreateEpisodeInput intentionally has no custom league-config
          // surface. Strict validation must reject this instead of silently
          // creating a default league while claiming the requested config.
          leagueConfig: { draftRounds: 3 },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await episodes.listPersisted()).toHaveLength(0);
    },
  );

  test(
    "the same seed and action sequence produces identical state hashes across two concurrent real episodes",
    { timeout: 180_000 },
    async () => {
      const runOnce = async (dataRoot: string): Promise<string[]> => {
        const episodes = new EpisodeManager(
          () => new BasketballGmEngine(),
          dataRoot,
        );
        const domain = new DomainService(
          episodes,
          createFileSnapshotStore(dataRoot),
        );
        try {
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
        } finally {
          await domain.closeAll();
        }
      };

      const [dataRootA, dataRootB] = await Promise.all([
        mkdtemp(join(tmpdir(), "bbgm-real-engine-det-test-a-")),
        mkdtemp(join(tmpdir(), "bbgm-real-engine-det-test-b-")),
      ]);
      dataRoots.push(dataRootA, dataRootB);
      const [a, b] = await Promise.all([
        runOnce(dataRootA),
        runOnce(dataRootB),
      ]);
      expect(a).toEqual(b);
    },
  );
});
