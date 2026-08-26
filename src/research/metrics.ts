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
  } = input;
  const gamesPlayed = finalState.userTeam.won + finalState.userTeam.lost;
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
    win_pct: gamesPlayed === 0 ? 0 : finalState.userTeam.won / gamesPlayed,
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
      trajectory.mutationSteps === 0
        ? 0
        : trajectory.invalidActionCount / trajectory.mutationSteps,
    tool_call_efficiency:
      trajectory.totalSteps === 0
        ? 0
        : trajectory.mutationSteps / trajectory.totalSteps,
    steps_used_ratio: trajectory.totalSteps / scenario.maxSteps,
  };
};
