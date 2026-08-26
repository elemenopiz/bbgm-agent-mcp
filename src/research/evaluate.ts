#!/usr/bin/env node
/**
 * Runs a scripted policy directly against DomainService, bypassing MCP
 * entirely, so protocol overhead never contaminates environment/metric
 * measurements. Semantics are identical to the MCP path because both call
 * the same DomainService methods.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DomainService } from "../domain/DomainService.js";
import type {
  DraftView,
  FreeAgentsView,
  MutationContext,
  OverviewView,
  RosterView,
} from "../domain/types.js";
import { BasketballGmEngine } from "../engine/bbgm/BasketballGmEngine.js";
import { createLogger } from "../logging/logger.js";
import { createFileSnapshotStore } from "../persistence/snapshots.js";
import { trajectoryPathFor } from "../persistence/trajectoryLog.js";
import { EpisodeManager } from "../sessions/EpisodeManager.js";
import { scalarReward, type RewardWeights } from "./objectives.js";
import { computeMetricComponents } from "./metrics.js";
import { loadScenarioManifest, type ScenarioManifest } from "./scenario.js";
import { readTrajectory, summarizeTrajectory } from "./trajectory.js";

const logger = createLogger("research:evaluate");

export type PolicyName = "no_op" | "heuristic";

type PolicyResult =
  { kind: "continue"; revision: number } | { kind: "stall"; reason: string };
type PolicyFn = (
  domain: DomainService,
  episodeId: string,
  revision: number,
  overview: OverviewView,
) => Promise<PolicyResult>;

const nextIdempotencyKey = (): string =>
  `eval-${randomUUID().replaceAll("-", "")}`.slice(0, 40);

/** Advances only; deliberately does not resolve mandatory decisions (e.g. drafting), so a stall is a research signal, not a bug to paper over. */
const noOpPolicy: PolicyFn = async (domain, episodeId, revision, overview) => {
  if (overview.nextDecision === "make_draft_pick") {
    return {
      kind: "stall" as const,
      reason: "no_op policy will not resolve a mandatory draft pick",
    };
  }
  const context: MutationContext = {
    expectedRevision: revision,
    idempotencyKey: nextIdempotencyKey(),
  };
  const result = await domain.advance(
    episodeId,
    { target: "next_decision" },
    context,
  );
  return { kind: "continue" as const, revision: result.revision };
};

/** A simple deterministic heuristic GM: drafts best-available, signs affordable free agents, otherwise advances. */
const heuristicPolicy: PolicyFn = async (
  domain,
  episodeId,
  revision,
  overview,
) => {
  const context: MutationContext = {
    expectedRevision: revision,
    idempotencyKey: nextIdempotencyKey(),
  };

  if (overview.nextDecision === "make_draft_pick") {
    const draftView = (await domain.getState({
      episodeId,
      view: "draft",
    })) as DraftView;
    const best = [...draftView.prospects].sort(
      (a, b) => b.scoutedOverall - a.scoutedOverall,
    )[0];
    if (!best)
      return {
        kind: "continue" as const,
        revision: (
          await domain.advance(episodeId, { target: "next_decision" }, context)
        ).revision,
      };
    const result = await domain.makeDraftPick(
      episodeId,
      { pid: best.pid },
      context,
    );
    return { kind: "continue" as const, revision: result.revision };
  }

  if (overview.userTeam.capSpace > 10 && overview.rosterCount < 15) {
    const freeAgents = (await domain.getState({
      episodeId,
      view: "free_agents",
    })) as FreeAgentsView;
    const best = [...freeAgents.players].sort(
      (a, b) => b.overall - a.overall,
    )[0];
    if (best) {
      const amount = Math.max(1, Math.min(overview.userTeam.capSpace, 8));
      const result = await domain.signFreeAgent(
        episodeId,
        { pid: best.pid, amount, years: 2 },
        context,
      );
      return { kind: "continue" as const, revision: result.revision };
    }
  }

  if (
    overview.userTeam.payroll > overview.userTeam.salaryCap &&
    overview.rosterCount > 10
  ) {
    const roster = (await domain.getState({
      episodeId,
      view: "roster",
    })) as RosterView;
    const worst = [...roster.players].sort((a, b) => a.overall - b.overall)[0];
    if (worst) {
      const result = await domain.releasePlayer(
        episodeId,
        { pid: worst.pid },
        context,
      );
      return { kind: "continue" as const, revision: result.revision };
    }
  }

  const result = await domain.advance(
    episodeId,
    { target: "next_decision" },
    context,
  );
  return { kind: "continue" as const, revision: result.revision };
};

const policies: Record<PolicyName, PolicyFn> = {
  no_op: noOpPolicy,
  heuristic: heuristicPolicy,
};

/**
 * Runs one scenario/seed/policy combination against an already-constructed
 * `DomainService`. Decoupled from engine choice so it's independently
 * testable against `FakeSimulationEngine` (see tests/integration) without
 * this module -- the actual CLI entry point below -- ever importing a fake
 * engine into the shipped production path.
 */
export const runEvaluation = async (options: {
  scenario: ScenarioManifest;
  seed: string;
  policyName: PolicyName;
  domain: DomainService;
  dataRoot: string;
}) => {
  const { scenario, seed, policyName, domain, dataRoot } = options;
  const policy = policies[policyName];

  let overview = await domain.createEpisode({
    scenarioId: scenario.scenarioId,
    seed,
    userTeamId: scenario.userTeamId,
    startingSeason: scenario.startingSeason,
    constraints: {
      hard: scenario.hardConstraints,
      soft: scenario.softObjectives,
    },
  });

  let steps = 0;
  let stallReason: string | undefined;
  const horizonSeason = scenario.startingSeason + scenario.horizonSeasons;

  while (steps < scenario.maxSteps && overview.season < horizonSeason) {
    const outcome = await policy(
      domain,
      overview.episodeId,
      overview.revision,
      overview,
    );
    steps += 1;
    if (outcome.kind === "stall") {
      stallReason = outcome.reason;
      break;
    }
    overview = (await domain.getState({
      episodeId: overview.episodeId,
      view: "overview",
    })) as OverviewView;
  }

  const [rosterView, draftView, constraintsView] = await Promise.all([
    domain.getState({
      episodeId: overview.episodeId,
      view: "roster",
    }) as Promise<RosterView>,
    domain.getState({
      episodeId: overview.episodeId,
      view: "draft",
    }) as Promise<DraftView>,
    domain.getState({ episodeId: overview.episodeId, view: "constraints" }),
  ]);

  const endResult = await domain.endEpisode(overview.episodeId, {
    exportFinalSnapshot: true,
  });

  const trajectory = await readTrajectory(
    trajectoryPathFor(dataRoot, overview.episodeId),
  );
  const trajectorySummary = summarizeTrajectory(trajectory);
  const metrics = computeMetricComponents({
    scenario,
    finalState: endResult.finalState,
    fullRoster: rosterView.players,
    ownedPicks: draftView.ownedPicks,
    finalConstraints:
      "constraints" in constraintsView ? constraintsView.constraints : [],
    terminalMetrics: endResult.terminalMetrics,
    trajectory: trajectorySummary,
  });

  return {
    scenarioId: scenario.scenarioId,
    seed,
    policyName,
    episodeId: overview.episodeId,
    stepsTaken: steps,
    stallReason,
    terminalMetrics: endResult.terminalMetrics,
    metricComponents: metrics,
    trajectorySummary,
  };
};

const DEFAULT_REWARD_WEIGHTS: RewardWeights = {
  win_pct: 1,
  total_asset_value: 0.01,
  hard_constraint_violations: -1,
  invalid_action_rate: -1,
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      policy: { type: "string", default: "heuristic" },
      seed: { type: "string" },
      "data-root": { type: "string", default: ".data" },
      out: { type: "string" },
    },
  });

  if (!values.scenario) {
    logger.error("missing required --scenario <path-to-manifest.json>");
    process.exitCode = 1;
    return;
  }
  const scenario = await loadScenarioManifest(resolve(values.scenario));
  const policyName = values.policy === "no_op" ? "no_op" : "heuristic";
  const dataRoot = resolve(values["data-root"] ?? ".data");
  const seeds = values.seed ? [values.seed] : scenario.seedSet;

  const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
  const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));

  const results = [];
  try {
    for (const seed of seeds) {
      logger.info("running evaluation", {
        scenarioId: scenario.scenarioId,
        policyName,
        seed,
      });
      const result = await runEvaluation({
        scenario,
        seed,
        policyName,
        domain,
        dataRoot,
      });
      results.push({
        ...result,
        scalarReward: scalarReward(
          result.metricComponents,
          DEFAULT_REWARD_WEIGHTS,
        ),
      });
    }
  } finally {
    await domain.closeAll();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    rewardWeights: DEFAULT_REWARD_WEIGHTS,
    results,
  };
  const output = JSON.stringify(report, null, 2);

  if (values.out) {
    const outPath = resolve(values.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, output, "utf8");
    logger.info("wrote report", { path: outPath });
  } else {
    process.stdout.write(`${output}\n`);
  }
};

const isMain =
  process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  main().catch((error: unknown) => {
    logger.error("evaluation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
