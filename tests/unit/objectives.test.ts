import { describe, expect, test } from "vitest";

import {
  compareRewardRuns,
  evaluateReward,
  rewardConfigSchema,
} from "../../src/research/objectives.js";

describe("research reward configuration", () => {
  test("evaluates a manifest-declared scalar reward", () => {
    const config = rewardConfigSchema.parse({
      mode: "scalar",
      weights: { win_pct: 2, invalid_action_rate: -1 },
    });
    expect(
      evaluateReward({ win_pct: 0.75, invalid_action_rate: 0.1 }, config),
    ).toEqual({
      mode: "scalar",
      value: 1.4,
      weights: { win_pct: 2, invalid_action_rate: -1 },
    });
  });

  test("requires the comparison dimensions for lexicographic and Pareto modes", () => {
    expect(() => rewardConfigSchema.parse({ mode: "lexicographic" })).toThrow(
      /order is required/,
    );
    expect(() => rewardConfigSchema.parse({ mode: "pareto" })).toThrow(
      /keys is required/,
    );
  });

  test("produces deterministic rankings and Pareto frontiers", () => {
    const candidates = [
      { episodeId: "b", metricComponents: { wins: 8, assets: 10 } },
      { episodeId: "a", metricComponents: { wins: 8, assets: 12 } },
      { episodeId: "c", metricComponents: { wins: 7, assets: 12 } },
    ];
    const lexicographic = rewardConfigSchema.parse({
      mode: "lexicographic",
      order: ["wins", "assets"],
    });
    expect(compareRewardRuns(candidates, lexicographic)).toEqual({
      mode: "lexicographic",
      order: ["wins", "assets"],
      rankedEpisodeIds: ["a", "b", "c"],
    });

    const pareto = rewardConfigSchema.parse({
      mode: "pareto",
      keys: ["wins", "assets"],
    });
    expect(compareRewardRuns(candidates, pareto)).toEqual({
      mode: "pareto",
      keys: ["wins", "assets"],
      frontierEpisodeIds: ["a"],
    });
  });

  test("honors explicit minimize directions for safety metrics", () => {
    const config = rewardConfigSchema.parse({
      mode: "lexicographic",
      order: ["hard_constraints_satisfied_at_end", "stale_action_rate"],
      directions: { stale_action_rate: "min" },
    });
    expect(
      compareRewardRuns(
        [
          {
            episodeId: "more-stale",
            metricComponents: {
              stale_action_rate: 0.2,
              hard_constraints_satisfied_at_end: 1,
            },
          },
          {
            episodeId: "less-stale",
            metricComponents: {
              stale_action_rate: 0.1,
              hard_constraints_satisfied_at_end: 1,
            },
          },
        ],
        config,
      ),
    ).toEqual({
      mode: "lexicographic",
      order: ["hard_constraints_satisfied_at_end", "stale_action_rate"],
      directions: { stale_action_rate: "min" },
      rankedEpisodeIds: ["less-stale", "more-stale"],
    });
  });

  test("ranks completed runs ahead of stalled runs despite better partial metrics", () => {
    const candidates = [
      {
        episodeId: "stalled",
        completionStatus: "stalled" as const,
        metricComponents: { win_pct: 1, total_asset_value: 200 },
      },
      {
        episodeId: "completed",
        completionStatus: "completed" as const,
        metricComponents: { win_pct: 0.5, total_asset_value: 100 },
      },
    ];
    const config = rewardConfigSchema.parse({
      mode: "scalar",
      weights: { win_pct: 1, total_asset_value: 0.01 },
    });

    expect(compareRewardRuns(candidates, config)).toEqual({
      mode: "scalar",
      rankedEpisodeIds: ["completed", "stalled"],
      completionRule: "completed_runs_rank_ahead_of_incomplete_runs",
    });
    expect(candidates[0]?.metricComponents).toEqual({
      win_pct: 1,
      total_asset_value: 200,
    });
  });

  test("applies completion precedence to Pareto frontiers", () => {
    const candidates = [
      {
        episodeId: "stalled",
        completionStatus: "stalled" as const,
        metricComponents: { wins: 10, assets: 20 },
      },
      {
        episodeId: "completed",
        completionStatus: "completed" as const,
        metricComponents: { wins: 8, assets: 10 },
      },
    ];
    const config = rewardConfigSchema.parse({
      mode: "pareto",
      keys: ["wins", "assets"],
    });

    expect(compareRewardRuns(candidates, config)).toEqual({
      mode: "pareto",
      keys: ["wins", "assets"],
      frontierEpisodeIds: ["completed"],
      completionRule: "completed_runs_rank_ahead_of_incomplete_runs",
    });
  });
});
