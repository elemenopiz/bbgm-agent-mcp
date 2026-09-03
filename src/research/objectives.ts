import * as z from "zod/v4";

export type MetricComponents = Record<string, number>;
export type RewardWeights = Record<string, number>;
export type RewardDirections = Record<string, "max" | "min">;

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export const DEFAULT_REWARD_WEIGHTS: RewardWeights = {
  win_pct: 1,
  total_asset_value: 0.01,
  hard_constraint_violations: -1,
  invalid_action_rate: -1,
};

const rewardMetricKeySchema = z.string().min(1).max(100);

/** Declarative comparison policy stored in a scenario manifest. */
export const rewardConfigSchema = z
  .object({
    mode: z.enum(["scalar", "lexicographic", "pareto"]).default("scalar"),
    weights: z
      .record(rewardMetricKeySchema, z.number().finite())
      .default(DEFAULT_REWARD_WEIGHTS),
    order: z.array(rewardMetricKeySchema).min(1).max(50).optional(),
    keys: z.array(rewardMetricKeySchema).min(1).max(50).optional(),
    directions: z
      .record(rewardMetricKeySchema, z.enum(["max", "min"]))
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.mode === "lexicographic" && config.order === undefined) {
      context.addIssue({
        code: "custom",
        path: ["order"],
        message: "order is required for lexicographic reward mode",
      });
    }
    if (config.mode === "pareto" && config.keys === undefined) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "keys is required for Pareto reward mode",
      });
    }
  });

export type RewardConfig = z.infer<typeof rewardConfigSchema>;

export type RewardEvaluation =
  | { mode: "scalar"; value: number; weights: RewardWeights }
  | { mode: "lexicographic"; order: string[]; values: MetricComponents }
  | { mode: "pareto"; keys: string[]; values: MetricComponents };

export const evaluateReward = (
  components: MetricComponents,
  config: RewardConfig,
): RewardEvaluation => {
  if (config.mode === "scalar") {
    return {
      mode: "scalar",
      value: scalarReward(components, config.weights),
      weights: config.weights,
    };
  }

  if (config.mode === "lexicographic") {
    const order = config.order;
    if (order === undefined) {
      throw new Error("Lexicographic reward configuration requires order");
    }
    return {
      mode: "lexicographic",
      order,
      values: Object.fromEntries(
        order.map((key) => [key, components[key] ?? 0]),
      ),
    };
  }

  if (config.keys === undefined) {
    throw new Error("Pareto reward configuration requires keys");
  }
  return {
    mode: "pareto",
    keys: config.keys,
    values: Object.fromEntries(
      config.keys.map((key) => [key, components[key] ?? 0]),
    ),
  };
};

/** Weighted linear combination. Any key in `weights` missing from `components` contributes 0. */
export const scalarReward = (
  components: MetricComponents,
  weights: RewardWeights,
): number =>
  Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + weight * (components[key] ?? 0),
    0,
  );

/** Metric keys in descending priority; earlier keys are compared first and only ties fall through. */
export type LexicographicOrder = string[];

/** Positive if `a` ranks ahead of `b`, negative if behind, 0 if fully tied on every key in `order`. */
export const compareLexicographic = (
  a: MetricComponents,
  b: MetricComponents,
  order: LexicographicOrder,
  directions: RewardDirections = {},
): number => {
  for (const key of order) {
    const diff =
      directions[key] === "min"
        ? (b[key] ?? 0) - (a[key] ?? 0)
        : (a[key] ?? 0) - (b[key] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** True if `a` is at least as good as `b` on every key and strictly better on at least one. */
export const paretoDominates = (
  a: MetricComponents,
  b: MetricComponents,
  keys: string[],
  directions: RewardDirections = {},
): boolean => {
  let strictlyBetterSomewhere = false;
  for (const key of keys) {
    const av = directions[key] === "min" ? -(a[key] ?? 0) : (a[key] ?? 0);
    const bv = directions[key] === "min" ? -(b[key] ?? 0) : (b[key] ?? 0);
    if (av < bv) return false;
    if (av > bv) strictlyBetterSomewhere = true;
  }
  return strictlyBetterSomewhere;
};

/** Filters a set of candidate runs down to the Pareto frontier over `keys`. */
export const paretoFrontier = <T>(
  candidates: T[],
  metricsOf: (candidate: T) => MetricComponents,
  keys: string[],
  directions: RewardDirections = {},
): T[] =>
  candidates.filter((candidate) => {
    const metrics = metricsOf(candidate);
    return !candidates.some(
      (other) =>
        other !== candidate &&
        paretoDominates(metricsOf(other), metrics, keys, directions),
    );
  });

export type RewardComparable = {
  episodeId: string;
  metricComponents: MetricComponents;
  /** Optional for compatibility with metric-only comparison callers. */
  completionStatus?: EvaluationCompletionStatus;
  /** Optional aggregate completion rate; higher rates rank first. */
  completionRate?: number;
};

export type EvaluationCompletionStatus =
  "completed" | "budget_exhausted" | "stalled";

/** Applied when comparison candidates include completion metadata. */
export const COMPLETION_COMPARISON_RULE =
  "completed_runs_rank_ahead_of_incomplete_runs" as const;

export type SeededRewardComparable = RewardComparable & {
  policyName: string;
  seed: string;
};

export type NumericSummary = {
  count: number;
  mean: number;
  standardDeviation: number;
  minimum: number;
  maximum: number;
};

export type RewardAggregate = {
  policyName: string;
  seeds: string[];
  runCount: number;
  metricComponents: MetricComponents;
  metricSummaries: Record<string, NumericSummary>;
};

export const validateMetricComponents = (
  components: MetricComponents,
  context: string,
): void => {
  for (const [key, value] of Object.entries(components)) {
    if (!Number.isFinite(value)) {
      throw new Error(`${context} contains a non-finite metric: ${key}`);
    }
  }
};

const summarizeValues = (values: number[]): NumericSummary => {
  if (values.length === 0) {
    throw new Error("Cannot summarize an empty metric series");
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    mean,
    standardDeviation: Math.sqrt(variance),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
};

const metricKeySet = (components: MetricComponents): string[] =>
  Object.keys(components).sort(compareStrings);

/**
 * Aggregates a policy's seed runs without depending on input order. Missing or
 * extra metric keys are rejected so a malformed run cannot silently become a
 * zero-valued observation in a grant report.
 */
export const aggregateRewardRuns = (
  candidates: SeededRewardComparable[],
): RewardAggregate[] => {
  const groups = new Map<string, SeededRewardComparable[]>();
  for (const candidate of candidates) {
    validateMetricComponents(
      candidate.metricComponents,
      `run ${candidate.episodeId}`,
    );
    const group = groups.get(candidate.policyName) ?? [];
    group.push(candidate);
    groups.set(candidate.policyName, group);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([policyName, runs]) => {
      const orderedRuns = [...runs].sort((a, b) => {
        const seedOrder = compareStrings(a.seed, b.seed);
        return seedOrder !== 0
          ? seedOrder
          : compareStrings(a.episodeId, b.episodeId);
      });
      const seeds = new Set<string>();
      for (const run of orderedRuns) {
        if (seeds.has(run.seed)) {
          throw new Error(
            `Duplicate seed ${run.seed} for policy ${policyName}`,
          );
        }
        seeds.add(run.seed);
      }
      const firstKeys = metricKeySet(orderedRuns[0]?.metricComponents ?? {});
      for (const run of orderedRuns) {
        if (
          JSON.stringify(metricKeySet(run.metricComponents)) !==
          JSON.stringify(firstKeys)
        ) {
          throw new Error(
            `Metric keys differ across runs for policy ${policyName}`,
          );
        }
      }

      const metricComponents = Object.fromEntries(
        firstKeys.map((key) => [
          key,
          summarizeValues(orderedRuns.map((run) => run.metricComponents[key]!))
            .mean,
        ]),
      );
      const metricSummaries = Object.fromEntries(
        firstKeys.map((key) => [
          key,
          summarizeValues(orderedRuns.map((run) => run.metricComponents[key]!)),
        ]),
      );
      return {
        policyName,
        seeds: orderedRuns.map((run) => run.seed),
        runCount: orderedRuns.length,
        metricComponents,
        metricSummaries,
      };
    });
};

/** Fails closed when a report would otherwise serialize NaN or Infinity as null. */
export const assertFiniteRewardEvaluation = (
  reward: RewardEvaluation,
  context: string,
): void => {
  if (reward.mode === "scalar") {
    if (!Number.isFinite(reward.value)) {
      throw new Error(`${context} contains a non-finite scalar reward`);
    }
    validateMetricComponents(reward.weights, `${context} weights`);
    return;
  }
  validateMetricComponents(reward.values, `${context} values`);
};

export type RewardComparison =
  | ({
      mode: "scalar";
      rankedEpisodeIds: string[];
    } & CompletionComparisonOutput)
  | ({
      mode: "lexicographic";
      order: string[];
      rankedEpisodeIds: string[];
      directions?: RewardDirections;
    } & CompletionComparisonOutput)
  | ({
      mode: "pareto";
      keys: string[];
      frontierEpisodeIds: string[];
      directions?: RewardDirections;
    } & CompletionComparisonOutput);

type CompletionComparisonOutput = {
  completionRule?: typeof COMPLETION_COMPARISON_RULE;
};

const completionPriority = (
  status: EvaluationCompletionStatus | undefined,
): number => (status === undefined || status === "completed" ? 0 : 1);

const compareCompletionStatus = (
  a: RewardComparable,
  b: RewardComparable,
): number => {
  if (
    a.completionRate !== undefined &&
    b.completionRate !== undefined &&
    a.completionRate !== b.completionRate
  ) {
    return b.completionRate - a.completionRate;
  }
  const aPriority = completionPriority(a.completionStatus);
  const bPriority = completionPriority(b.completionStatus);
  return aPriority - bPriority;
};

const hasCompletionMetadata = <T extends RewardComparable>(
  candidates: T[],
): boolean =>
  candidates.some((candidate) => candidate.completionStatus !== undefined);

const withCompletionRule = <T extends object>(
  comparison: T,
  completionAware: boolean,
): T & CompletionComparisonOutput =>
  completionAware
    ? { ...comparison, completionRule: COMPLETION_COMPARISON_RULE }
    : comparison;

/** Produces a deterministic comparison artifact across comparison candidates. */
export const compareRewardRuns = <T extends RewardComparable>(
  candidates: T[],
  config: RewardConfig,
): RewardComparison => {
  const directions = config.directions ?? {};
  const completionAware = hasCompletionMetadata(candidates);
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.episodeId)) {
      throw new Error(`Duplicate comparison id: ${candidate.episodeId}`);
    }
    ids.add(candidate.episodeId);
    validateMetricComponents(
      candidate.metricComponents,
      `comparison ${candidate.episodeId}`,
    );
  }
  if (config.mode === "scalar") {
    return withCompletionRule(
      {
        mode: "scalar",
        rankedEpisodeIds: [...candidates]
          .sort((a, b) => {
            const completionDifference = compareCompletionStatus(a, b);
            if (completionDifference !== 0) return completionDifference;
            const difference =
              scalarReward(b.metricComponents, config.weights) -
              scalarReward(a.metricComponents, config.weights);
            return difference !== 0
              ? difference
              : compareStrings(a.episodeId, b.episodeId);
          })
          .map((candidate) => candidate.episodeId),
      },
      completionAware,
    );
  }

  if (config.mode === "lexicographic") {
    const order = config.order;
    if (order === undefined) {
      throw new Error("Lexicographic reward configuration requires order");
    }
    return withCompletionRule(
      {
        mode: "lexicographic",
        order,
        ...(Object.keys(directions).length === 0 ? {} : { directions }),
        rankedEpisodeIds: [...candidates]
          .sort((a, b) => {
            const completionDifference = compareCompletionStatus(a, b);
            if (completionDifference !== 0) return completionDifference;
            const difference = compareLexicographic(
              b.metricComponents,
              a.metricComponents,
              order,
              directions,
            );
            return difference !== 0
              ? difference
              : compareStrings(a.episodeId, b.episodeId);
          })
          .map((candidate) => candidate.episodeId),
      },
      completionAware,
    );
  }

  if (config.keys === undefined) {
    throw new Error("Pareto reward configuration requires keys");
  }
  const paretoCandidates = candidates.some(
    (candidate) => candidate.completionStatus === "completed",
  )
    ? candidates.filter(
        (candidate) =>
          candidate.completionStatus === undefined ||
          candidate.completionStatus === "completed",
      )
    : candidates;
  return withCompletionRule(
    {
      mode: "pareto",
      keys: config.keys,
      ...(Object.keys(directions).length === 0 ? {} : { directions }),
      frontierEpisodeIds: paretoFrontier(
        paretoCandidates,
        (candidate) => candidate.metricComponents,
        config.keys,
        directions,
      )
        .sort((a, b) => compareStrings(a.episodeId, b.episodeId))
        .map((candidate) => candidate.episodeId),
    },
    completionAware,
  );
};
