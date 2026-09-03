#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DomainService } from "../src/domain/DomainService.js";
import type {
  DraftView,
  OverviewView,
  RosterView,
  TradeProposal,
} from "../src/domain/types.js";
import {
  BASKETBALL_GM_ENGINE_METADATA,
  BasketballGmEngine,
} from "../src/engine/bbgm/BasketballGmEngine.js";
import { createFileSnapshotStore } from "../src/persistence/snapshots.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";
import { WRAPPER_VERSION } from "../src/version.js";

const root = resolve(import.meta.dirname, "..");
const DEMO_STARTING_SEASON = 2026;
const outputPath = resolve(
  root,
  process.argv[2] ?? ".data/meaningful-demo/decision-timeline.json",
);

type StateMarker = Pick<
  OverviewView,
  "revision" | "stateHash" | "season" | "phase" | "nextDecision"
> & {
  day?: number;
  rosterCount: number;
  ownedPickCount: number;
};

type TimelineEntry = {
  label: string;
  action: Record<string, unknown>;
  before?: StateMarker;
  after?: StateMarker;
  details?: Record<string, unknown>;
};

const marker = (state: OverviewView): StateMarker => ({
  revision: state.revision,
  stateHash: state.stateHash,
  season: state.season,
  phase: state.phase,
  ...(state.day === undefined ? {} : { day: state.day }),
  nextDecision: state.nextDecision,
  rosterCount: state.rosterCount,
  ownedPickCount: state.ownedPickCount,
});

const main = async (): Promise<void> => {
  // Keep a custom output path self-contained so a fresh demo cannot silently
  // reuse episode logs from an earlier run.
  const dataRoot = resolve(root, process.argv[3] ?? dirname(outputPath));
  await mkdir(dataRoot, { recursive: true });
  const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
  const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));
  const timeline: TimelineEntry[] = [];

  try {
    let state = await domain.createEpisode({
      scenarioId: "meaningful-decision-demo-v1",
      seed: "grant-meaningful-demo-seed",
      userTeamId: 0,
      startingSeason: DEMO_STARTING_SEASON,
      scenarioPolicy: {
        allowedAdvanceTargets: [
          "until_regular_season",
          "until_trade_deadline",
          "until_playoffs",
          "through_playoffs",
          "until_draft",
          "until_next_pick",
        ],
        maxSteps: 300,
        horizonSeasons: 2,
      },
    });
    let revision = state.revision;
    const key = (label: string): string =>
      `meaningful-demo-${label}-${revision}`;
    const readOverview = async (): Promise<OverviewView> =>
      (await domain.getState({
        episodeId: state.episodeId,
        view: "overview",
      })) as OverviewView;

    const mutate = async (
      label: string,
      action: Record<string, unknown>,
      operation: (
        expectedRevision: number,
        idempotencyKey: string,
      ) => Promise<{
        revision: number;
        stateHash: string;
        events: Record<string, unknown>[];
      }>,
      details?: Record<string, unknown>,
    ): Promise<void> => {
      const before = marker(state);
      const result = await operation(revision, key(label));
      revision = result.revision;
      state = await readOverview();
      timeline.push({
        label,
        action,
        before,
        after: marker(state),
        ...(details === undefined
          ? { details: { events: result.events } }
          : { details: { ...details, events: result.events } }),
      });
    };

    timeline.push({
      label: "create_episode",
      action: {
        type: "create_episode",
        scenarioId: "meaningful-decision-demo-v1",
        seed: "grant-meaningful-demo-seed",
      },
      after: marker(state),
    });

    const checkpoint = await domain.createCheckpoint(state.episodeId);
    timeline.push({
      label: "create_initial_checkpoint",
      action: { type: "create_checkpoint" },
      details: {
        checkpointId: checkpoint.checkpointId,
        revision: checkpoint.revision,
        stateHash: checkpoint.stateHash,
      },
    });

    await mutate(
      "advance_to_regular_season",
      { type: "advance", target: "until_regular_season" },
      (expectedRevision, idempotencyKey) =>
        domain.advance(
          state.episodeId,
          { target: "until_regular_season" },
          { expectedRevision, idempotencyKey },
        ),
    );

    const roster = (await domain.getState({
      episodeId: state.episodeId,
      view: "roster",
    })) as RosterView;
    const rosterOrder = roster.players.map((player) => player.pid).reverse();
    await mutate(
      "set_lineup",
      { type: "set_lineup", order: rosterOrder },
      (expectedRevision, idempotencyKey) =>
        domain.setLineup(
          state.episodeId,
          { order: rosterOrder },
          { expectedRevision, idempotencyKey },
        ),
      { rosterManagement: "reordered full roster through typed lineup action" },
    );

    const worst = [...roster.players].sort((a, b) => a.overall - b.overall)[0];
    if (!worst) throw new Error("meaningful demo expected a rostered player");
    await mutate(
      "release_lowest_overall_player",
      { type: "release_player", pid: worst.pid },
      (expectedRevision, idempotencyKey) =>
        domain.releasePlayer(
          state.episodeId,
          { pid: worst.pid },
          { expectedRevision, idempotencyKey },
        ),
      { player: worst.name },
    );

    const freeAgents = await domain.getState({
      episodeId: state.episodeId,
      view: "free_agents",
      limit: 1,
    });
    if (freeAgents.view !== "free_agents" || !freeAgents.players[0]) {
      throw new Error("meaningful demo expected a free agent after release");
    }
    const freeAgent = freeAgents.players[0];
    await mutate(
      "sign_free_agent",
      { type: "sign_free_agent", pid: freeAgent.pid, amount: 1.2, years: 2 },
      (expectedRevision, idempotencyKey) =>
        domain.signFreeAgent(
          state.episodeId,
          { pid: freeAgent.pid, amount: 1.2, years: 2 },
          { expectedRevision, idempotencyKey },
        ),
      { player: freeAgent.name },
    );

    const offeredRoster = (await domain.getState({
      episodeId: state.episodeId,
      view: "roster",
    })) as RosterView;
    const offeredCandidates = [...offeredRoster.players]
      .sort((a, b) => a.overall - b.overall)
      .slice(0, 8);
    let selectedTrade:
      { proposal: TradeProposal; evaluation: unknown } | undefined;
    for (
      let offset = 1;
      offset <= 8 && selectedTrade === undefined;
      offset += 1
    ) {
      const otherTeamId = (state.userTeam.tid + offset) % 30;
      const otherRoster = (await domain.getState({
        episodeId: state.episodeId,
        view: "roster",
        teamId: otherTeamId,
      })) as RosterView;
      const requestedCandidates = [...otherRoster.players]
        .sort((a, b) => a.overall - b.overall)
        .slice(0, 8);
      for (const offered of offeredCandidates) {
        for (const requested of requestedCandidates) {
          const proposal: TradeProposal = {
            otherTeamId,
            offered: [{ type: "player", pid: offered.pid }],
            requested: [{ type: "player", pid: requested.pid }],
          };
          const evaluation = await domain.evaluateTrade(
            state.episodeId,
            proposal,
          );
          if (evaluation.legal && evaluation.acceptedByOtherTeam === true) {
            selectedTrade = { proposal, evaluation };
            break;
          }
        }
        if (selectedTrade !== undefined) break;
      }
    }
    if (selectedTrade === undefined) {
      for (
        let offset = 1;
        offset <= 8 && selectedTrade === undefined;
        offset += 1
      ) {
        const proposal: TradeProposal = {
          otherTeamId: (state.userTeam.tid + offset) % 30,
          offered: [{ type: "player", pid: offeredCandidates[0]!.pid }],
          requested: [],
        };
        const evaluation = await domain.evaluateTrade(
          state.episodeId,
          proposal,
        );
        if (evaluation.legal && evaluation.acceptedByOtherTeam === true) {
          selectedTrade = { proposal, evaluation };
        }
      }
    }
    if (selectedTrade === undefined) {
      throw new Error(
        "pinned engine exposed no accepted legal trade in bounded demo search",
      );
    }
    await mutate(
      "evaluate_and_execute_accepted_trade",
      { type: "execute_trade", ...selectedTrade.proposal },
      (expectedRevision, idempotencyKey) =>
        domain.executeTrade(state.episodeId, selectedTrade.proposal, {
          expectedRevision,
          idempotencyKey,
        }),
      { evaluation: selectedTrade.evaluation },
    );

    await mutate(
      "advance_to_trade_deadline",
      { type: "advance", target: "until_trade_deadline" },
      (expectedRevision, idempotencyKey) =>
        domain.advance(
          state.episodeId,
          { target: "until_trade_deadline" },
          { expectedRevision, idempotencyKey },
        ),
    );

    const beforeDraftCheckpoint = await domain.createCheckpoint(
      state.episodeId,
    );
    timeline.push({
      label: "create_pre_draft_checkpoint",
      action: { type: "create_checkpoint" },
      details: {
        checkpointId: beforeDraftCheckpoint.checkpointId,
        revision: beforeDraftCheckpoint.revision,
        stateHash: beforeDraftCheckpoint.stateHash,
      },
    });

    const advanceToDraft = async (label: string): Promise<void> => {
      await mutate(
        `${label}_playoffs`,
        { type: "advance", target: "until_playoffs" },
        (expectedRevision, idempotencyKey) =>
          domain.advance(
            state.episodeId,
            { target: "until_playoffs" },
            { expectedRevision, idempotencyKey },
          ),
      );
      await mutate(
        `${label}_through_playoffs`,
        { type: "advance", target: "through_playoffs" },
        (expectedRevision, idempotencyKey) =>
          domain.advance(
            state.episodeId,
            { target: "through_playoffs" },
            { expectedRevision, idempotencyKey },
          ),
      );
      await mutate(
        `${label}_draft`,
        { type: "advance", target: "until_draft" },
        (expectedRevision, idempotencyKey) =>
          domain.advance(
            state.episodeId,
            { target: "until_draft" },
            { expectedRevision, idempotencyKey },
          ),
      );
      await mutate(
        `${label}_next_pick`,
        { type: "advance", target: "until_next_pick" },
        (expectedRevision, idempotencyKey) =>
          domain.advance(
            state.episodeId,
            { target: "until_next_pick" },
            { expectedRevision, idempotencyKey },
          ),
      );
    };
    await advanceToDraft("advance_to_draft");
    const draft = (await domain.getState({
      episodeId: state.episodeId,
      view: "draft",
    })) as DraftView;
    const prospect = draft.prospects[0];
    if (!prospect)
      throw new Error("meaningful demo expected an available prospect");
    const firstPickPid = prospect.pid;
    await mutate(
      "make_draft_pick",
      { type: "make_draft_pick", pid: firstPickPid },
      (expectedRevision, idempotencyKey) =>
        domain.makeDraftPick(
          state.episodeId,
          { pid: firstPickPid },
          { expectedRevision, idempotencyKey },
        ),
      { prospect: prospect.name, scoutedOverall: prospect.scoutedOverall },
    );

    const beforeRestore = marker(state);
    const restored = await domain.restoreCheckpoint(
      state.episodeId,
      beforeDraftCheckpoint.checkpointId,
      {
        expectedRevision: revision,
        idempotencyKey: key("restore-pre-draft"),
      },
    );
    revision = restored.revision;
    state = await readOverview();
    timeline.push({
      label: "restore_pre_draft_checkpoint",
      action: {
        type: "restore_checkpoint",
        checkpointId: beforeDraftCheckpoint.checkpointId,
      },
      before: beforeRestore,
      after: marker(state),
      details: { restoredStateHash: state.stateHash },
    });

    await advanceToDraft("replay_after_checkpoint_restore");
    const replayDraft = (await domain.getState({
      episodeId: state.episodeId,
      view: "draft",
    })) as DraftView;
    const replayProspect = replayDraft.prospects.find(
      (candidate) => candidate.pid === firstPickPid,
    );
    if (!replayProspect) {
      throw new Error(
        "checkpoint restore did not reproduce the selected prospect",
      );
    }
    await mutate(
      "make_replayed_draft_pick",
      { type: "make_draft_pick", pid: replayProspect.pid },
      (expectedRevision, idempotencyKey) =>
        domain.makeDraftPick(
          state.episodeId,
          { pid: replayProspect.pid },
          { expectedRevision, idempotencyKey },
        ),
      { prospect: replayProspect.name, deterministicReplay: true },
    );

    const ended = await domain.endEpisode(state.episodeId, {
      exportFinalSnapshot: true,
    });
    const output = {
      schemaVersion: "meaningful-demo.v1",
      wrapperVersion: WRAPPER_VERSION,
      generatedAt: new Date().toISOString(),
      purpose:
        "Deterministic reviewer demonstration of typed roster, trade, deadline, draft, checkpoint, and rollback decisions.",
      engine: BASKETBALL_GM_ENGINE_METADATA,
      episodeId: state.episodeId,
      scenarioId: "meaningful-decision-demo-v1",
      seed: "grant-meaningful-demo-seed",
      startingSeason: DEMO_STARTING_SEASON,
      dataRoot,
      timeline,
      finalState: ended.finalState,
      terminalMetrics: ended.terminalMetrics,
      reviewerInterpretation: {
        trade: "accepted legal player exchange selected after evaluation",
        safety:
          "all mutations passed revision, idempotency, phase, legality, and invariant checks",
        rollback:
          "pre-draft checkpoint restored, then the same draft prospect was selected again",
      },
    };
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.error(`meaningful-demo: wrote ${outputPath}`);
  } finally {
    await domain.closeAll();
  }
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `meaningful-demo: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
