#!/usr/bin/env node
/**
 * Runs a scripted policy directly against DomainService, bypassing MCP
 * entirely, so protocol overhead never contaminates environment/metric
 * measurements. Semantics are identical to the MCP path because both call
 * the same DomainService methods.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DomainService } from "../domain/DomainService.js";
import { GET_STATE_VIEWS } from "../domain/types.js";
import type {
  AdvanceInput,
  AdvertiseOnTradingBlockInput,
  Checkpoint,
  DraftView,
  EngineMetadata,
  FreeAgentsView,
  GetStateInput,
  GetStateViewName,
  LeagueStateView,
  MakeDraftPickInput,
  MutationContext,
  MutationResult,
  NegotiateContractInput,
  OverviewView,
  OptionsResult,
  ReleasePlayerInput,
  RosterView,
  SetLineupInput,
  SignFreeAgentInput,
  TerminalMetrics,
  TradeEvaluation,
  TradeProposal,
} from "../domain/types.js";
import {
  BASKETBALL_GM_ENGINE_METADATA,
  BasketballGmEngine,
} from "../engine/bbgm/BasketballGmEngine.js";
import { createLogger } from "../logging/logger.js";
import { createFileSnapshotStore } from "../persistence/snapshots.js";
import { trajectoryPathFor } from "../persistence/trajectoryLog.js";
import { EpisodeManager } from "../sessions/EpisodeManager.js";
import {
  aggregateRewardRuns,
  assertFiniteRewardEvaluation,
  compareRewardRuns,
  evaluateObjectiveSeparation,
  evaluateReward,
  validateMetricComponents,
  type RewardComparison,
  type RewardEvaluation,
  type SeparatedObjectiveScores,
  type RewardAggregate,
} from "./objectives.js";
import { computeMetricComponents } from "./metrics.js";
import {
  computePairedStatistics,
  type StatisticalAnalysis,
} from "./statistics.js";
import { loadScenarioManifest, type ScenarioManifest } from "./scenario.js";
import {
  readAttempts,
  readTrajectory,
  summarizeTrajectory,
  type TrajectorySummary,
} from "./trajectory.js";
import { attemptLogPathFor } from "../persistence/attemptLog.js";
import { WRAPPER_VERSION } from "../version.js";

const logger = createLogger("research:evaluate");

export type PolicyName =
  | "no_op"
  | "heuristic"
  | "untrained_open_model"
  | "prompted_open_model"
  | "fine_tuned_model"
  | "frontier_reference_model"
  | "tinker";

export type PolicyResult =
  { kind: "continue"; revision: number } | { kind: "stall"; reason: string };
type PolicyFn = (
  environment: AgentEnvironment,
  revision: number,
  observation: AgentObservation,
) => Promise<PolicyResult>;

/** Provider/parser/tool telemetry that is not visible in DomainService's
 * attempt log (for example, a model response that never yielded a typed
 * action). Keeping it beside the result prevents parse failures from being
 * misreported as zero invalid actions. */
export type PolicyTelemetry = {
  modelCallCount: number;
  parseErrorCount: number;
  providerErrorCount: number;
  modelErrorCount: number;
  toolErrorCount: number;
};

const emptyPolicyTelemetry = (): PolicyTelemetry => ({
  modelCallCount: 0,
  parseErrorCount: 0,
  providerErrorCount: 0,
  modelErrorCount: 0,
  toolErrorCount: 0,
});

export type PolicyAdapterKind = "deterministic_baseline" | "external_model";

export type PolicyAdapterMetadata = {
  name: PolicyName;
  label: string;
  kind: PolicyAdapterKind;
  version: string;
  available: boolean;
  provider: string;
  /** Optional identity fields for external/open-model provenance. */
  modelId?: string;
  modelRevision?: string;
  promptVersion?: string;
  promptSha256?: string;
  endpoint?: string;
  decoding?: {
    temperature: number;
    maxTokens: number;
    seed?: number;
  };
};

export type AgentObservation = {
  schemaVersion: "agent-observation.v1";
  episodeId: string;
  revision: number;
  stateHash: string;
  season: number;
  phase: OverviewView["phase"];
  /** Only views included in the scenario's allowedInformation list. */
  views: Partial<Record<GetStateViewName, LeagueStateView>>;
  /** Present only when the scenario permits the options information channel. */
  options?: OptionsResult["options"];
};

export type AgentEnvironment = {
  /** Opaque episode identity; no lifecycle methods are exposed. */
  readonly episodeId: string;
  observe: () => Promise<AgentObservation>;
  getState: (
    input: Omit<GetStateInput, "episodeId">,
  ) => Promise<LeagueStateView>;
  getOptions: () => Promise<OptionsResult>;
  evaluateTrade: (proposal: TradeProposal) => Promise<TradeEvaluation>;
  executeTrade: (
    proposal: TradeProposal,
    context: MutationContext,
  ) => Promise<MutationResult>;
  advertiseOnTradingBlock: (
    input: AdvertiseOnTradingBlockInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  setLineup: (
    input: SetLineupInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  releasePlayer: (
    input: ReleasePlayerInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  negotiateContract: (
    input: NegotiateContractInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  signFreeAgent: (
    input: SignFreeAgentInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  makeDraftPick: (
    input: MakeDraftPickInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  advance: (
    input: AdvanceInput,
    context: MutationContext,
  ) => Promise<MutationResult>;
  createCheckpoint: () => Promise<Checkpoint>;
  listCheckpoints: () => Checkpoint[];
  restoreCheckpoint: (
    checkpointId: string,
    context: MutationContext,
  ) => Promise<MutationResult>;
};

export type PolicyStepContext = {
  environment: AgentEnvironment;
  episodeId: string;
  revision: number;
  observation: AgentObservation;
  scenario: ScenarioManifest;
  seed: string;
  stepNumber: number;
};

/**
 * Transport-independent policy contract. External model integrations own
 * their client/session lifecycle and only need to translate one observation
 * into one typed environment operation per call. The policy receives only an
 * `AgentEnvironment` capability; evaluator-only state and lifecycle methods
 * remain private to this module.
 */
export type PolicyAdapter = {
  metadata: PolicyAdapterMetadata;
  step: (context: PolicyStepContext) => Promise<PolicyResult>;
  getTelemetry?: () => PolicyTelemetry;
  dispose?: () => Promise<void>;
};

export class PolicyUnavailableError extends Error {
  readonly code = "POLICY_UNAVAILABLE";

  constructor(
    public readonly policyName: PolicyName,
    reason: string,
  ) {
    super(`Policy ${policyName} is unavailable: ${reason}`);
    this.name = "PolicyUnavailableError";
  }
}

const nextIdempotencyKey = (): string =>
  `eval-${randomUUID().replaceAll("-", "")}`.slice(0, 40);

const overviewFromObservation = (
  observation: AgentObservation,
): OverviewView => {
  const overview = observation.views.overview;
  if (overview?.view !== "overview") {
    throw new Error(
      "This policy requires the scenario's overview information channel",
    );
  }
  return overview;
};

// Each AgentEnvironment is created for exactly one episode. A weak key keeps
// refusal probes out of later episodes without introducing a cleanup path into
// the policy contract.
const refusedFreeAgentPidsByEpisode = new WeakMap<
  AgentEnvironment,
  Set<number>
>();

/** Advances only; deliberately does not resolve mandatory decisions (e.g. drafting), so a stall is a research signal, not a bug to paper over. */
const noOpPolicy: PolicyFn = async (environment, revision, observation) => {
  const overview = overviewFromObservation(observation);
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
  // The compact overview phase includes both sides of the trade deadline, so
  // use the phase-step controller instead of retrying a deadline milestone.
  const result = await environment.advance(
    { target: "next_decision" },
    context,
  );
  return { kind: "continue" as const, revision: result.revision };
};

/** A simple deterministic heuristic GM: resolves mandatory drafts, fills a
 * short resigning-window roster, signs affordable free agents, otherwise
 * advances. It is intentionally transparent rather than strategically strong.
 */
const heuristicPolicy: PolicyFn = async (
  environment,
  revision,
  observation,
) => {
  const overview = overviewFromObservation(observation);
  let refusedFreeAgentPids = refusedFreeAgentPidsByEpisode.get(environment);
  if (refusedFreeAgentPids === undefined) {
    refusedFreeAgentPids = new Set<number>();
    refusedFreeAgentPidsByEpisode.set(environment, refusedFreeAgentPids);
  }
  const context: MutationContext = {
    expectedRevision: revision,
    idempotencyKey: nextIdempotencyKey(),
  };

  if (overview.phase === "draft") {
    if (overview.nextDecision !== "make_draft_pick") {
      const result = await environment.advance(
        { target: "next_decision" },
        context,
      );
      return { kind: "continue" as const, revision: result.revision };
    }
    if (overview.rosterCount >= 15) {
      const roster = (await environment.getState({
        view: "roster",
      })) as RosterView;
      const worst = [...roster.players].sort(
        (a, b) => a.overall - b.overall || a.potential - b.potential,
      )[0];
      if (worst) {
        const result = await environment.releasePlayer(
          { pid: worst.pid },
          context,
        );
        return { kind: "continue" as const, revision: result.revision };
      }
    }
    const draftView = (await environment.getState({
      view: "draft",
    })) as DraftView;
    const best = [...draftView.prospects].sort(
      (a, b) => b.scoutedOverall - a.scoutedOverall,
    )[0];
    if (!best) {
      const result = await environment.advance(
        { target: "next_decision" },
        context,
      );
      return { kind: "continue" as const, revision: result.revision };
    }
    const result = await environment.makeDraftPick({ pid: best.pid }, context);
    return { kind: "continue" as const, revision: result.revision };
  }

  if (
    overview.phase === "resigning" &&
    overview.nextDecision === "negotiate_contract"
  ) {
    const roster = (await environment.getState({
      view: "roster",
    })) as RosterView;
    const candidates = roster.players
      .filter((player) => player.contractExpires <= overview.season)
      .sort((a, b) => b.overall - a.overall || b.potential - a.potential);
    for (const candidate of candidates) {
      try {
        const result = await environment.negotiateContract(
          {
            pid: candidate.pid,
            amount: Math.max(1, candidate.contractAmount),
            years: 2,
          },
          { ...context, idempotencyKey: nextIdempotencyKey() },
        );
        return { kind: "continue" as const, revision: result.revision };
      } catch (error) {
        // Resigning willingness can change between the public roster view and
        // the accept call. Try another player when the engine reports that
        // specific preflight rejection; preserve all other failures.
        if (
          !(error instanceof Error) ||
          !error.message.includes("no longer willing to negotiate")
        ) {
          throw error;
        }
      }
    }
    return {
      kind: "stall" as const,
      reason: "heuristic could not negotiate any pending resigning contract",
    };
  }

  // Basketball GM only permits ordinary free-agent signing in the
  // preseason/free-agency phases. The domain's compact phase model merges
  // the two regular-season subphases, so avoid attempting this action there
  // and let the engine advance to a legal window instead.
  // Leave room for the two controlled draft picks when signing in preseason.
  const signingRosterLimit = overview.phase === "preseason" ? 13 : 15;
  if (
    (overview.phase === "preseason" || overview.phase === "free_agency") &&
    overview.userTeam.capSpace > 10 &&
    overview.rosterCount < signingRosterLimit
  ) {
    const freeAgents = (await environment.getState({
      view: "free_agents",
    })) as FreeAgentsView;
    // BBGM's public free-agent view does not expose the private willingness
    // bit. Prefer the lowest listed demand, then talent, so the transparent
    // baseline does not spend the episode exhaustively probing players who
    // the upstream engine will reject before negotiation starts.
    const candidates = [...freeAgents.players]
      .filter((candidate) => !refusedFreeAgentPids.has(candidate.pid))
      .sort(
        (a, b) => a.contractAmount - b.contractAmount || b.overall - a.overall,
      )
      .slice(0, 8);
    const amount = Math.max(1, Math.min(overview.userTeam.capSpace, 8));
    for (const candidate of candidates) {
      try {
        const result = await environment.signFreeAgent(
          { pid: candidate.pid, amount, years: 2 },
          { ...context, idempotencyKey: nextIdempotencyKey() },
        );
        return { kind: "continue" as const, revision: result.revision };
      } catch (error) {
        // Willingness is stochastic in the real engine and is not included
        // in the public free-agent view. Try another candidate when the
        // engine explicitly reports a refusal; preserve all other failures.
        if (
          !(error instanceof Error) ||
          !error.message.includes("refuses to sign")
        ) {
          throw error;
        }
        refusedFreeAgentPids.add(candidate.pid);
      }
    }
  }

  if (overview.phase === "free_agency" && overview.rosterCount < 10) {
    return {
      kind: "stall" as const,
      reason: "heuristic could not fill the minimum roster in free_agency",
    };
  }

  if (
    overview.userTeam.payroll > overview.userTeam.salaryCap &&
    overview.rosterCount > 10
  ) {
    const roster = (await environment.getState({
      view: "roster",
    })) as RosterView;
    const worst = [...roster.players].sort((a, b) => a.overall - b.overall)[0];
    if (worst) {
      const result = await environment.releasePlayer(
        { pid: worst.pid },
        context,
      );
      return { kind: "continue" as const, revision: result.revision };
    }
  }

  const result = await environment.advance(
    { target: "next_decision" },
    context,
  );
  return { kind: "continue" as const, revision: result.revision };
};

const createAgentEnvironment = (
  domain: DomainService,
  episodeId: string,
  scenario: ScenarioManifest,
): AgentEnvironment => {
  const allowedInformation = new Set(scenario.allowedInformation);
  const allowedActions = new Set(scenario.allowedActions);

  const assertInformation = (view: string): void => {
    if (!allowedInformation.has(view)) {
      throw new Error(`Scenario does not allow information channel: ${view}`);
    }
  };
  const assertAction = (action: string): void => {
    if (!allowedActions.has(action)) {
      throw new Error(`Scenario does not allow action: ${action}`);
    }
  };

  const getState = async (
    input: Omit<GetStateInput, "episodeId">,
  ): Promise<LeagueStateView> => {
    assertInformation(input.view);
    return domain.getState({ episodeId, ...input });
  };

  const observe = async (): Promise<AgentObservation> => {
    const views: Partial<Record<GetStateViewName, LeagueStateView>> = {};
    for (const view of GET_STATE_VIEWS) {
      if (allowedInformation.has(view)) {
        views[view] = await getState({ view, limit: 50 });
      }
    }
    const anchor = views.overview ?? Object.values(views)[0];
    if (anchor === undefined) {
      throw new Error(
        "Scenario must allow at least one state information channel for policy evaluation",
      );
    }
    const options = allowedInformation.has("options")
      ? (await domain.getOptions(episodeId, "evaluator")).options.slice(0, 50)
      : undefined;
    return {
      schemaVersion: "agent-observation.v1",
      episodeId,
      revision: anchor.revision,
      stateHash: anchor.stateHash,
      season: anchor.season,
      phase: anchor.phase,
      views,
      ...(options === undefined ? {} : { options }),
    };
  };

  return {
    episodeId,
    observe,
    getState,
    getOptions: async () => {
      assertInformation("options");
      return domain.getOptions(episodeId);
    },
    evaluateTrade: async (proposal) => {
      assertAction("evaluate_trade");
      return domain.evaluateTrade(episodeId, proposal);
    },
    executeTrade: async (proposal, context) => {
      assertAction("execute_trade");
      return domain.executeTrade(episodeId, proposal, context);
    },
    advertiseOnTradingBlock: async (input, context) => {
      assertAction("advertise_on_trading_block");
      return domain.advertiseOnTradingBlock(episodeId, input, context);
    },
    setLineup: async (input, context) => {
      assertAction("set_lineup");
      return domain.setLineup(episodeId, input, context);
    },
    releasePlayer: async (input, context) => {
      assertAction("release_player");
      return domain.releasePlayer(episodeId, input, context);
    },
    negotiateContract: async (input, context) => {
      assertAction("negotiate_contract");
      return domain.negotiateContract(episodeId, input, context);
    },
    signFreeAgent: async (input, context) => {
      assertAction("sign_free_agent");
      return domain.signFreeAgent(episodeId, input, context);
    },
    makeDraftPick: async (input, context) => {
      assertAction("make_draft_pick");
      return domain.makeDraftPick(episodeId, input, context);
    },
    advance: async (input, context) => {
      assertAction("advance");
      return domain.advance(episodeId, input, context);
    },
    createCheckpoint: async () => {
      assertAction("create_checkpoint");
      return domain.createCheckpoint(episodeId);
    },
    listCheckpoints: () => {
      assertAction("list_checkpoints");
      return domain.listCheckpoints(episodeId);
    },
    restoreCheckpoint: async (checkpointId, context) => {
      assertAction("restore_checkpoint");
      return domain.restoreCheckpoint(episodeId, checkpointId, context);
    },
  };
};

const deterministicAdapter = (
  metadata: PolicyAdapterMetadata,
  policy: PolicyFn,
): PolicyAdapter => ({
  metadata,
  step: ({ environment, revision, observation }) =>
    policy(environment, revision, observation),
});

const unavailableAdapter = (
  name: PolicyName,
  label: string,
  provider: string,
  reason: string,
): PolicyAdapter => ({
  metadata: {
    name,
    label,
    kind: "external_model",
    version: "adapter-contract-1",
    available: false,
    provider,
  },
  step: async () => {
    throw new PolicyUnavailableError(name, reason);
  },
});

export const createDefaultPolicyRegistry = (): ReadonlyMap<
  PolicyName,
  PolicyAdapter
> =>
  new Map<PolicyName, PolicyAdapter>([
    [
      "no_op",
      deterministicAdapter(
        {
          name: "no_op",
          label: "No-op / advance-only baseline",
          kind: "deterministic_baseline",
          version: "builtin-1",
          available: true,
          provider: "bbgm-agent-mcp",
        },
        noOpPolicy,
      ),
    ],
    [
      "heuristic",
      deterministicAdapter(
        {
          name: "heuristic",
          label: "Deterministic heuristic baseline",
          kind: "deterministic_baseline",
          version: "builtin-1",
          available: true,
          provider: "bbgm-agent-mcp",
        },
        heuristicPolicy,
      ),
    ],
    [
      "untrained_open_model",
      unavailableAdapter(
        "untrained_open_model",
        "Untrained open model",
        "external",
        "register an external PolicyAdapter implementation before running it",
      ),
    ],
    [
      "prompted_open_model",
      unavailableAdapter(
        "prompted_open_model",
        "Prompted open model",
        "external",
        "register an external PolicyAdapter implementation before running it",
      ),
    ],
    [
      "fine_tuned_model",
      unavailableAdapter(
        "fine_tuned_model",
        "Fine-tuned model",
        "external",
        "register an external PolicyAdapter implementation before running it",
      ),
    ],
    [
      "frontier_reference_model",
      unavailableAdapter(
        "frontier_reference_model",
        "Frontier reference model",
        "external",
        "register an external PolicyAdapter implementation before running it",
      ),
    ],
    [
      "tinker",
      unavailableAdapter(
        "tinker",
        "Tinker model run",
        "thinking-machines-lab-tinker",
        "no Tinker API client is available locally; register a concrete adapter rather than using a mock integration",
      ),
    ],
  ]);

export const defaultPolicyRegistry = createDefaultPolicyRegistry();

export const resolvePolicyAdapter = (
  policyName: PolicyName,
  registry: ReadonlyMap<PolicyName, PolicyAdapter> = defaultPolicyRegistry,
): PolicyAdapter => {
  const adapter = registry.get(policyName);
  if (adapter === undefined) {
    throw new Error(`Unknown policy adapter: ${policyName}`);
  }
  if (!adapter.metadata.available) {
    throw new PolicyUnavailableError(
      policyName,
      "the adapter is registered as a contract placeholder but has no runtime implementation",
    );
  }
  return adapter;
};

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot fingerprint a non-finite value");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Cannot fingerprint an unsupported value");
};

export const sha256Json = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export const scenarioFingerprint = (scenario: ScenarioManifest): string =>
  sha256Json(scenario);

const unknownEngineMetadata: EngineMetadata = {
  name: "unknown",
  version: "unknown",
};

export type EvaluationCompletionStatus =
  "completed" | "budget_exhausted" | "stalled";

export type EvaluationResult = {
  scenarioId: string;
  seed: string;
  policyName: PolicyName;
  episodeId: string;
  stepsTaken: number;
  completionStatus: EvaluationCompletionStatus;
  stallReason?: string;
  adapter: PolicyAdapterMetadata;
  engine: EngineMetadata;
  initialSnapshotHash?: string;
  terminalMetrics: TerminalMetrics;
  metricComponents: Record<string, number>;
  reward: RewardEvaluation;
  /** Present when the scenario declares an objectiveSeparation. Scores the
   * same recorded components against the visible proxy and the hidden
   * intended objective, so proxy-intent divergence is computable from the
   * stored report without re-running anything. */
  objectiveScores?: SeparatedObjectiveScores;
  trajectorySummary: TrajectorySummary;
  policyTelemetry: PolicyTelemetry;
};

const assertNonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
};

const assertEvaluationResultIntegrity = (result: EvaluationResult): void => {
  assertNonNegativeInteger(result.stepsTaken, "stepsTaken");
  for (const [label, value] of Object.entries(result.trajectorySummary)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`trajectorySummary.${label} must be finite`);
    }
  }
  validateMetricComponents(result.metricComponents, "metricComponents");
  assertFiniteRewardEvaluation(result.reward, "reward");
  for (const [label, value] of Object.entries(result.policyTelemetry)) {
    assertNonNegativeInteger(value, `policyTelemetry.${label}`);
  }
  const { agentAttemptCount, rejectedAttemptCount, staleActionCount } =
    result.trajectorySummary;
  if (
    rejectedAttemptCount > agentAttemptCount ||
    staleActionCount > agentAttemptCount
  ) {
    throw new Error("trajectory attempt counters are inconsistent");
  }
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
  initialSnapshot?: unknown;
  initialSnapshotHash?: string;
  engineMetadata?: EngineMetadata;
  policyAdapter?: PolicyAdapter;
}) => {
  const {
    scenario,
    seed,
    policyName,
    domain,
    dataRoot,
    initialSnapshot,
    initialSnapshotHash,
  } = options;
  if (!scenario.seedSet.includes(seed)) {
    throw new Error(
      `Seed ${seed} is not declared in scenario ${scenario.scenarioId}; add it to the manifest before evaluating`,
    );
  }
  const adapter =
    options.policyAdapter ??
    resolvePolicyAdapter(policyName, defaultPolicyRegistry);
  if (adapter.metadata.name !== policyName) {
    throw new Error(
      `Policy adapter name ${adapter.metadata.name} does not match ${policyName}`,
    );
  }
  if (!adapter.metadata.available) {
    throw new PolicyUnavailableError(
      policyName,
      "the adapter is registered as unavailable",
    );
  }

  const engine = options.engineMetadata ?? unknownEngineMetadata;
  const inputSnapshotHash =
    initialSnapshotHash ??
    (initialSnapshot === undefined ? undefined : sha256Json(initialSnapshot));
  let overview: OverviewView | undefined;
  let environment: AgentEnvironment | undefined;
  let observation: AgentObservation | undefined;
  let ended = false;

  try {
    overview = await domain.createEpisode({
      scenarioId: scenario.scenarioId,
      seed,
      userTeamId: scenario.userTeamId,
      startingSeason: scenario.startingSeason,
      constraints: {
        hard: scenario.hardConstraints,
        soft: scenario.softObjectives,
      },
      scenarioPolicy: {
        allowedInformation: scenario.allowedInformation,
        allowedActions: scenario.allowedActions,
        ...(scenario.allowedAdvanceTargets === undefined
          ? {}
          : { allowedAdvanceTargets: scenario.allowedAdvanceTargets }),
        maxSteps: scenario.maxSteps,
        horizonSeasons: scenario.horizonSeasons,
      },
      ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
    });
    environment = createAgentEnvironment(domain, overview.episodeId, scenario);
    observation = await environment.observe();

    let steps = 0;
    let stallReason: string | undefined;
    const horizonSeason = scenario.startingSeason + scenario.horizonSeasons;

    while (steps < scenario.maxSteps && overview.season < horizonSeason) {
      steps += 1;
      let outcome: PolicyResult;
      try {
        outcome = await adapter.step({
          environment,
          episodeId: overview.episodeId,
          revision: overview.revision,
          observation,
          scenario,
          seed,
          stepNumber: steps - 1,
        });
      } catch (error: unknown) {
        const code =
          error instanceof Error && "code" in error
            ? String((error as Error & { code?: unknown }).code)
            : "POLICY_STEP_ERROR";
        const message = error instanceof Error ? error.message : String(error);
        stallReason = `policy step failed (${code}): ${message}`;
        break;
      }
      if (outcome.kind === "stall") {
        stallReason = outcome.reason;
        break;
      }
      overview = (await domain.getStateForEvaluation({
        episodeId: overview.episodeId,
        view: "overview",
      })) as OverviewView;
      observation = await environment.observe();
    }

    const [rosterView, draftView, constraintsView] = await Promise.all([
      domain.getStateForEvaluation({
        episodeId: overview.episodeId,
        view: "roster",
      }) as Promise<RosterView>,
      domain.getStateForEvaluation({
        episodeId: overview.episodeId,
        view: "draft",
      }) as Promise<DraftView>,
      domain.getStateForEvaluation({
        episodeId: overview.episodeId,
        view: "constraints",
      }),
    ]);

    const endResult = await domain.endEpisode(overview.episodeId, {
      exportFinalSnapshot: true,
    });
    ended = true;

    const trajectory = await readTrajectory(
      trajectoryPathFor(dataRoot, overview.episodeId),
    );
    const attempts = await readAttempts(
      attemptLogPathFor(dataRoot, overview.episodeId),
    );
    const trajectorySummary = summarizeTrajectory(trajectory, attempts);
    const policyTelemetry = {
      ...emptyPolicyTelemetry(),
      ...(adapter.getTelemetry?.() ?? {}),
    };
    const metrics = computeMetricComponents({
      scenario,
      finalState: endResult.finalState,
      fullRoster: rosterView.players,
      ownedPicks: draftView.ownedPicks,
      finalConstraints:
        "constraints" in constraintsView ? constraintsView.constraints : [],
      terminalMetrics: endResult.terminalMetrics,
      trajectory: trajectorySummary,
      policyStepsTaken: steps,
      policyTelemetry,
    });

    const result: EvaluationResult = {
      scenarioId: scenario.scenarioId,
      seed,
      policyName,
      episodeId: overview.episodeId,
      stepsTaken: steps,
      completionStatus:
        stallReason === undefined
          ? overview.season >= horizonSeason
            ? "completed"
            : "budget_exhausted"
          : "stalled",
      ...(stallReason === undefined ? {} : { stallReason }),
      adapter: adapter.metadata,
      engine,
      ...(inputSnapshotHash === undefined
        ? {}
        : { initialSnapshotHash: inputSnapshotHash }),
      terminalMetrics: endResult.terminalMetrics,
      metricComponents: metrics,
      reward: evaluateReward(metrics, scenario.reward),
      ...(scenario.objectiveSeparation === undefined
        ? {}
        : {
            objectiveScores: evaluateObjectiveSeparation(
              metrics,
              scenario.objectiveSeparation,
            ),
          }),
      trajectorySummary,
      policyTelemetry,
    };

    assertEvaluationResultIntegrity(result);
    return result;
  } finally {
    if (overview !== undefined && !ended) {
      await domain
        .endEpisode(overview.episodeId, { exportFinalSnapshot: true })
        .catch(() => undefined);
    }
    await adapter.dispose?.();
  }
};

export type EvaluationAggregate = RewardAggregate & {
  adapter: PolicyAdapterMetadata;
  completedRunCount: number;
  budgetExhaustedRunCount: number;
  stalledRunCount: number;
  completionRate: number;
  reward: RewardEvaluation;
};

export type EvaluationProvenance = {
  schemaVersion: 1;
  wrapperVersion: string;
  nodeVersion: string;
  platform: string;
  scenarioId: string;
  scenarioFingerprint: string;
  declaredSeeds: string[];
  evaluatedSeeds: string[];
  runOrder: string[];
  engineIdentities: EngineMetadata[];
  initialSnapshotHashes: string[];
  policyAdapters: PolicyAdapterMetadata[];
  commandLine: string;
  repository: {
    gitCommit: string;
    workingTreeClean: boolean;
    gitStatusSha256: string;
    gitDiffSha256: string;
    lockfileSha256: string;
  };
};

export type EvaluationReport = {
  reportVersion: 1;
  generatedAt: string;
  scenario: ScenarioManifest;
  reward: ScenarioManifest["reward"];
  provenance: EvaluationProvenance;
  aggregates: EvaluationAggregate[];
  comparison: RewardComparison;
  statistics: StatisticalAnalysis;
  results: EvaluationResult[];
};

const sortByStableIdentity = (
  a: { policyName: string; seed: string; episodeId: string },
  b: { policyName: string; seed: string; episodeId: string },
): number => {
  const policyOrder =
    a.policyName < b.policyName ? -1 : a.policyName > b.policyName ? 1 : 0;
  if (policyOrder !== 0) return policyOrder;
  const seedOrder = a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0;
  if (seedOrder !== 0) return seedOrder;
  return a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0;
};

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const gitOutput = (args: string[]): string => {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
};

const fileSha256 = (path: string): string => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unavailable";
  }
};

const sameEngineIdentity = (a: EngineMetadata, b: EngineMetadata): boolean =>
  a.name === b.name && a.version === b.version && a.commit === b.commit;

const aggregateCompletionStatus = (
  aggregate: Pick<
    EvaluationAggregate,
    | "runCount"
    | "completedRunCount"
    | "budgetExhaustedRunCount"
    | "stalledRunCount"
  >,
): EvaluationCompletionStatus => {
  if (aggregate.completedRunCount === aggregate.runCount) {
    return "completed";
  }
  if (
    aggregate.budgetExhaustedRunCount > 0 &&
    aggregate.stalledRunCount === 0
  ) {
    return "budget_exhausted";
  }
  return "stalled";
};

const sameAdapterIdentity = (
  a: PolicyAdapterMetadata,
  b: PolicyAdapterMetadata,
): boolean =>
  a.name === b.name &&
  a.label === b.label &&
  a.kind === b.kind &&
  a.version === b.version &&
  a.available === b.available &&
  a.provider === b.provider &&
  a.modelId === b.modelId &&
  a.modelRevision === b.modelRevision &&
  a.promptVersion === b.promptVersion &&
  a.promptSha256 === b.promptSha256 &&
  a.endpoint === b.endpoint &&
  JSON.stringify(a.decoding) === JSON.stringify(b.decoding);

/** Runs independent seed/policy episodes with an explicit concurrency cap
 * while preserving the deterministic ordering used in the serialized report.
 * The real BBGM bridge is process-global and its worker lifecycle is not safe
 * for concurrent episodes, so serialization is the default. Parallelism is
 * retained as an explicit opt-in for isolated/mock engines and future bridge
 * implementations that prove they support it. */
const mapWithConcurrency = async <T, R>(
  items: T[],
  requestedConcurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  };
  const concurrency = Math.max(
    1,
    Math.min(items.length || 1, Math.floor(requestedConcurrency)),
  );
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
};

/** Builds a sorted, validated report from all seed/policy runs. */
export const buildEvaluationReport = (options: {
  scenario: ScenarioManifest;
  results: EvaluationResult[];
  initialSnapshotHash?: string;
  generatedAt?: string;
}): EvaluationReport => {
  const orderedResults = [...options.results].sort(sortByStableIdentity);
  if (orderedResults.length === 0) {
    throw new Error("Cannot build an evaluation report without any runs");
  }
  for (const result of orderedResults) {
    if (result.scenarioId !== options.scenario.scenarioId) {
      throw new Error(
        `Result ${result.episodeId} belongs to scenario ${result.scenarioId}`,
      );
    }
    if (!options.scenario.seedSet.includes(result.seed)) {
      throw new Error(
        `Result ${result.episodeId} uses undeclared seed ${result.seed}`,
      );
    }
    assertEvaluationResultIntegrity(result);
  }

  const aggregates = aggregateRewardRuns(orderedResults).map((aggregate) => {
    const policyRuns = orderedResults.filter(
      (result) => result.policyName === aggregate.policyName,
    );
    const firstAdapter = policyRuns[0]?.adapter;
    if (firstAdapter === undefined) {
      throw new Error(`Missing adapter metadata for ${aggregate.policyName}`);
    }
    if (
      policyRuns.some(
        (result) => !sameAdapterIdentity(result.adapter, firstAdapter),
      )
    ) {
      throw new Error(
        `Adapter identity differs across runs for ${aggregate.policyName}`,
      );
    }
    const completionCounts = {
      completedRunCount: policyRuns.filter(
        (result) => result.completionStatus === "completed",
      ).length,
      budgetExhaustedRunCount: policyRuns.filter(
        (result) => result.completionStatus === "budget_exhausted",
      ).length,
      stalledRunCount: policyRuns.filter(
        (result) => result.completionStatus === "stalled",
      ).length,
    };
    const completionRate =
      policyRuns.length === 0
        ? 0
        : completionCounts.completedRunCount / policyRuns.length;
    return {
      ...aggregate,
      ...completionCounts,
      completionRate,
      adapter: firstAdapter,
      reward: evaluateReward(
        aggregate.metricComponents,
        options.scenario.reward,
      ),
    };
  });

  const engines = orderedResults.map((result) => result.engine);
  const engineIdentities = engines.filter(
    (engine, index) =>
      engines.findIndex((candidate) =>
        sameEngineIdentity(candidate, engine),
      ) === index,
  );
  const initialSnapshotHashes = uniqueSorted(
    orderedResults
      .map((result) => result.initialSnapshotHash)
      .filter((hash): hash is string => hash !== undefined),
  );
  if (options.initialSnapshotHash !== undefined) {
    initialSnapshotHashes.push(options.initialSnapshotHash);
  }
  const sortedInitialSnapshotHashes = uniqueSorted(initialSnapshotHashes);
  if (
    options.initialSnapshotHash !== undefined &&
    orderedResults.some(
      (result) =>
        result.initialSnapshotHash !== undefined &&
        result.initialSnapshotHash !== options.initialSnapshotHash,
    )
  ) {
    throw new Error("Initial snapshot provenance differs across report inputs");
  }
  const adapters = aggregates.map((aggregate) => aggregate.adapter);
  const provenance: EvaluationProvenance = {
    schemaVersion: 1,
    wrapperVersion: WRAPPER_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    scenarioId: options.scenario.scenarioId,
    scenarioFingerprint: scenarioFingerprint(options.scenario),
    declaredSeeds: uniqueSorted(options.scenario.seedSet),
    evaluatedSeeds: uniqueSorted(orderedResults.map((result) => result.seed)),
    runOrder: orderedResults.map(
      (result) => `${result.policyName}:${result.seed}:${result.episodeId}`,
    ),
    engineIdentities,
    initialSnapshotHashes: sortedInitialSnapshotHashes,
    policyAdapters: adapters,
    commandLine: process.argv.join(" "),
    repository: {
      gitCommit: gitOutput(["rev-parse", "HEAD"]),
      workingTreeClean: gitOutput(["status", "--porcelain"]).length === 0,
      gitStatusSha256: createHash("sha256")
        .update(gitOutput(["status", "--porcelain"]), "utf8")
        .digest("hex"),
      gitDiffSha256: createHash("sha256")
        .update(gitOutput(["diff", "--binary", "HEAD"]), "utf8")
        .digest("hex"),
      lockfileSha256: fileSha256(resolve(process.cwd(), "pnpm-lock.yaml")),
    },
  };
  const report: EvaluationReport = {
    reportVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scenario: options.scenario,
    reward: options.scenario.reward,
    provenance,
    aggregates,
    comparison: compareRewardRuns(
      aggregates.map((aggregate) => ({
        episodeId: aggregate.policyName,
        metricComponents: aggregate.metricComponents,
        completionStatus: aggregateCompletionStatus(aggregate),
        completionRate: aggregate.completionRate,
      })),
      options.scenario.reward,
    ),
    statistics: computePairedStatistics(
      orderedResults.map((result) => ({
        policyName: result.policyName,
        seed: result.seed,
        completionStatus: result.completionStatus,
        metricComponents: result.metricComponents,
      })),
    ),
    results: orderedResults,
  };
  return report;
};

const parsePolicies = (
  value: string,
  registry: ReadonlyMap<PolicyName, PolicyAdapter>,
): PolicyName[] => {
  if (value === "all") {
    return [...registry.values()]
      .filter((adapter) => adapter.metadata.available)
      .sort((a, b) =>
        a.metadata.name < b.metadata.name
          ? -1
          : a.metadata.name > b.metadata.name
            ? 1
            : 0,
      )
      .map((adapter) => adapter.metadata.name);
  }
  if (registry.has(value as PolicyName)) return [value as PolicyName];
  throw new Error(`unsupported policy: ${value}`);
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
  const scenarioPath = resolve(values.scenario);
  let initialSnapshot: unknown;
  let initialSnapshotHash: string | undefined;
  if (scenario.initialSnapshotPath !== undefined) {
    const initialSnapshotRaw = await readFile(
      resolve(dirname(scenarioPath), scenario.initialSnapshotPath),
      "utf8",
    );
    initialSnapshot = JSON.parse(initialSnapshotRaw) as unknown;
    initialSnapshotHash = createHash("sha256")
      .update(initialSnapshotRaw, "utf8")
      .digest("hex");
  }
  const policyRegistry = defaultPolicyRegistry;
  const policiesToRun = parsePolicies(
    values.policy ?? "heuristic",
    policyRegistry,
  );
  const dataRoot = resolve(values["data-root"] ?? ".data");
  const seeds = values.seed ? [values.seed] : scenario.seedSet;

  const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
  const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));
  const engineMetadata = BASKETBALL_GM_ENGINE_METADATA;

  const jobs = policiesToRun.flatMap((policyName) =>
    seeds.map((seed) => ({ policyName, seed })),
  );
  let results: EvaluationResult[];
  try {
    results = await mapWithConcurrency(
      jobs,
      Number(process.env["BBGM_EVAL_PARALLELISM"] ?? 1),
      async ({ policyName, seed }) => {
        logger.info("running evaluation", {
          scenarioId: scenario.scenarioId,
          policyName,
          seed,
        });
        return runEvaluation({
          scenario,
          seed,
          policyName,
          domain,
          dataRoot,
          engineMetadata,
          ...(initialSnapshotHash === undefined ? {} : { initialSnapshotHash }),
          ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
        });
      },
    );
  } finally {
    await domain.closeAll();
  }

  const report = buildEvaluationReport({
    scenario,
    results,
    ...(initialSnapshotHash === undefined ? {} : { initialSnapshotHash }),
  });
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
