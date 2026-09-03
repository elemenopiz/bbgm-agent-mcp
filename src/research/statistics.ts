import type { MetricComponents } from "./objectives.js";

export type StatisticalRun = {
  policyName: string;
  seed: string;
  completionStatus: "completed" | "budget_exhausted" | "stalled";
  metricComponents: MetricComponents;
};

export type PairedMetricEffect = {
  metric: string;
  n: number;
  /** Treatment minus comparator, retaining stalled runs (intention-to-treat). */
  meanDelta: number;
  standardDeviation: number;
  confidenceInterval95: { lower: number; upper: number };
  /** Cohen's dz; null when all paired deltas are constant. */
  cohensDz: number | null;
};

export type PairwisePolicyEffect = {
  treatment: string;
  comparator: string;
  analysisUnit: "paired_seed_intention_to_treat";
  seeds: string[];
  treatmentCompletionRate: number;
  comparatorCompletionRate: number;
  effects: PairedMetricEffect[];
};

export type StatisticalAnalysis = {
  schemaVersion: "paired-statistics.v1";
  confidenceLevel: 0.95;
  intervalMethod: "normal_approximation_paired_differences";
  effectSize: "cohens_dz";
  stalledRunTreatment: "retain_reported_partial_metrics_intention_to_treat";
  pairs: PairwisePolicyEffect[];
};

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const sampleStandardDeviation = (values: number[], average: number): number => {
  if (values.length < 2) return 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  );
};

const metricEffect = (metric: string, deltas: number[]): PairedMetricEffect => {
  const average = mean(deltas);
  const standardDeviation = sampleStandardDeviation(deltas, average);
  const margin =
    deltas.length === 0
      ? 0
      : (1.96 * standardDeviation) / Math.sqrt(deltas.length);
  return {
    metric,
    n: deltas.length,
    meanDelta: average,
    standardDeviation,
    confidenceInterval95: {
      lower: average - margin,
      upper: average + margin,
    },
    cohensDz:
      standardDeviation === 0
        ? average === 0
          ? 0
          : null
        : average / standardDeviation,
  };
};

/**
 * Computes paired seed effects without dropping stalled runs. This is an
 * intentionally modest descriptive analysis for small pilot seed sets; it is
 * not a claim of inferential validity beyond the declared approximation.
 */
export const computePairedStatistics = (
  runs: StatisticalRun[],
): StatisticalAnalysis => {
  const policies = sorted(runs.map((run) => run.policyName));
  const pairs: PairwisePolicyEffect[] = [];
  for (const treatment of policies) {
    for (const comparator of policies) {
      if (treatment === comparator) continue;
      const treatmentBySeed = new Map(
        runs
          .filter((run) => run.policyName === treatment)
          .map((run) => [run.seed, run]),
      );
      const comparatorBySeed = new Map(
        runs
          .filter((run) => run.policyName === comparator)
          .map((run) => [run.seed, run]),
      );
      const seeds = sorted(
        [...treatmentBySeed.keys()].filter((seed) =>
          comparatorBySeed.has(seed),
        ),
      );
      if (seeds.length === 0) continue;
      const firstTreatment = treatmentBySeed.get(seeds[0]!);
      const firstComparator = comparatorBySeed.get(seeds[0]!);
      if (firstTreatment === undefined || firstComparator === undefined)
        continue;
      const metrics = sorted(
        Object.keys(firstTreatment.metricComponents).filter((metric) =>
          Object.hasOwn(firstComparator.metricComponents, metric),
        ),
      );
      pairs.push({
        treatment,
        comparator,
        analysisUnit: "paired_seed_intention_to_treat",
        seeds,
        treatmentCompletionRate:
          seeds.filter(
            (seed) =>
              treatmentBySeed.get(seed)?.completionStatus === "completed",
          ).length / seeds.length,
        comparatorCompletionRate:
          seeds.filter(
            (seed) =>
              comparatorBySeed.get(seed)?.completionStatus === "completed",
          ).length / seeds.length,
        effects: metrics.map((metric) =>
          metricEffect(
            metric,
            seeds.map(
              (seed) =>
                treatmentBySeed.get(seed)!.metricComponents[metric]! -
                comparatorBySeed.get(seed)!.metricComponents[metric]!,
            ),
          ),
        ),
      });
    }
  }
  return {
    schemaVersion: "paired-statistics.v1",
    confidenceLevel: 0.95,
    intervalMethod: "normal_approximation_paired_differences",
    effectSize: "cohens_dz",
    stalledRunTreatment: "retain_reported_partial_metrics_intention_to_treat",
    pairs,
  };
};
