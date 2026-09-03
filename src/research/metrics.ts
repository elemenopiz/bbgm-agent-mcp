import type {
  ConstraintStatus,
  DraftPickSummary,
  OverviewView,
  PlayerSummary,
  TerminalMetrics,
} from "../domain/types.js";
import type { MetricComponents } from "./objectives.js";
import type { ScenarioManifest } from "./scenario.js";
import type { TrajectorySummary } from "./trajectory.js";
import type { PolicyTelemetry } from "./evaluate.js";

const playerValue = (player: PlayerSummary): number =>
  player.overall * 2 + player.potential;
const pickValue = (pick: DraftPickSummary): number =>
  pick.round === 1 ? 40 : 15;

export type MetricInput = {
  scenario: ScenarioManifest;
  finalState: OverviewView;
  fullRoster: PlayerSummary[];
  ownedPicks: DraftPickSummary[];
  finalConstraints: ConstraintStatus[];
  terminalMetrics: TerminalMetrics;
  trajectory: TrajectorySummary;
  /** Number of policy decision turns, including read-only model actions. */
  policyStepsTaken?: number;
  /** Model/parser/provider telemetry not represented by DomainService logs. */
  policyTelemetry?: PolicyTelemetry;
};

/**
 * Flat, documented metric components. Never collapsed into a single opaque
 * reward here -- callers choose a scalar weighting (objectives.ts
 * scalarReward) or a lexicographic/Pareto comparison over this same bag.
 */
export const computeMetricComponents = (
  input: MetricInput,
): MetricComponents => {
  const {
    finalState,
    fullRoster,
    ownedPicks,
    finalConstraints,
    terminalMetrics,
    trajectory,
    scenario,
    policyStepsTaken,
    policyTelemetry,
  } = input;
  const modelCallCount = policyTelemetry?.modelCallCount ?? 0;
  const modelParseErrorCount = policyTelemetry?.parseErrorCount ?? 0;
  const modelProviderErrorCount = policyTelemetry?.providerErrorCount ?? 0;
  const modelErrorCount = policyTelemetry?.modelErrorCount ?? 0;
  const modelToolErrorCount = policyTelemetry?.toolErrorCount ?? 0;
  const modelInvalidActionCount = modelParseErrorCount + modelToolErrorCount;
  const actionDenominator = trajectory.agentAttemptCount + modelParseErrorCount;
  const gamesPlayed =
    terminalMetrics.finalRecord.won + terminalMetrics.finalRecord.lost;
  const rosterAgeAvg =
    fullRoster.length === 0
      ? 0
      : fullRoster.reduce((sum, p) => sum + p.age, 0) / fullRoster.length;
  const rosterOverallAvg =
    fullRoster.length === 0
      ? 0
      : fullRoster.reduce((sum, p) => sum + p.overall, 0) / fullRoster.length;
  const currentPlayerValue = fullRoster.reduce(
    (sum, p) => sum + playerValue(p),
    0,
  );
  const draftCapitalValue = ownedPicks.reduce(
    (sum, pick) => sum + pickValue(pick),
    0,
  );
  const satisfiedHard = finalConstraints
    .filter((c) => c.kind === "hard")
    .every((c) => c.satisfied)
    ? 1
    : 0;
  const constraintSatisfactionRate =
    finalConstraints.length === 0
      ? 1
      : finalConstraints.filter((c) => c.satisfied).length /
        finalConstraints.length;

  return {
    win_pct:
      gamesPlayed === 0 ? 0 : terminalMetrics.finalRecord.won / gamesPlayed,
    games_played: gamesPlayed,
    seasons_completed: terminalMetrics.seasonsCompleted,
    hard_constraint_violations: terminalMetrics.hardConstraintViolations,
    hard_constraints_satisfied_at_end: satisfiedHard,
    constraint_satisfaction_rate: constraintSatisfactionRate,
    transaction_count: terminalMetrics.transactionCount,
    roster_avg_age: rosterAgeAvg,
    roster_avg_overall: rosterOverallAvg,
    current_player_value: currentPlayerValue,
    draft_capital_value: draftCapitalValue,
    total_asset_value: currentPlayerValue + draftCapitalValue,
    cap_space: finalState.userTeam.capSpace,
    invalid_action_rate:
      actionDenominator === 0
        ? 0
        : (trajectory.rejectedAttemptCount + modelParseErrorCount) /
          actionDenominator,
    model_call_count: modelCallCount,
    model_parse_error_count: modelParseErrorCount,
    model_provider_error_count: modelProviderErrorCount,
    model_error_count: modelErrorCount,
    model_tool_error_count: modelToolErrorCount,
    model_invalid_action_rate:
      modelCallCount === 0 ? 0 : modelInvalidActionCount / modelCallCount,
    stale_action_rate:
      trajectory.agentAttemptCount === 0
        ? 0
        : trajectory.staleActionCount / trajectory.agentAttemptCount,
    tool_call_efficiency:
      trajectory.totalSteps === 0
        ? 0
        : trajectory.mutationSteps / trajectory.totalSteps,
    decision_efficiency:
      trajectory.agentAttemptCount === 0
        ? 0
        : terminalMetrics.seasonsCompleted / trajectory.agentAttemptCount,
    agent_attempts_per_completed_season:
      terminalMetrics.seasonsCompleted === 0
        ? 0
        : trajectory.agentAttemptCount / terminalMetrics.seasonsCompleted,
    // The domain budget is consumed by action attempts, including rejected
    // mutations. Accepted trajectory records alone undercount the budget when
    // a policy retries an invalid action against the real engine.
    // `maxSteps` is also the evaluator's one-action-per-turn budget. Reads
    // used while constructing an observation are deliberately absent from
    // agentAttemptCount, so this metric must use the evaluator's turn count
    // rather than the audit-log tool count. This keeps the ratio bounded by 1.
    steps_used_ratio:
      (policyStepsTaken ?? trajectory.agentAttemptCount) / scenario.maxSteps,
  };
};
