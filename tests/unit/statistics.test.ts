import { describe, expect, test } from "vitest";

import { computePairedStatistics } from "../../src/research/statistics.js";

const run = (
  policyName: string,
  seed: string,
  totalAssetValue: number,
  completionStatus: "completed" | "budget_exhausted" | "stalled" = "completed",
) => ({
  policyName,
  seed,
  completionStatus,
  metricComponents: {
    win_pct: totalAssetValue / 1000,
    total_asset_value: totalAssetValue,
    invalid_action_rate: 0,
  },
});

describe("paired research statistics", () => {
  test("pairs by seed, retains stalled runs, and reports effect size", () => {
    const analysis = computePairedStatistics([
      run("heuristic", "s1", 1100),
      run("heuristic", "s2", 900),
      run("no_op", "s1", 1000, "stalled"),
      run("no_op", "s2", 800),
    ]);
    const effect = analysis.pairs.find(
      (pair) => pair.treatment === "heuristic" && pair.comparator === "no_op",
    );
    expect(effect?.seeds).toEqual(["s1", "s2"]);
    expect(effect?.treatmentCompletionRate).toBe(1);
    expect(effect?.comparatorCompletionRate).toBe(0.5);
    expect(
      effect?.effects.find(
        (candidate) => candidate.metric === "total_asset_value",
      ),
    ).toMatchObject({
      n: 2,
      meanDelta: 100,
      standardDeviation: 0,
      cohensDz: null,
    });
  });
});
