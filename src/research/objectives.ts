export type MetricComponents = Record<string, number>;
export type RewardWeights = Record<string, number>;

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
): number => {
  for (const key of order) {
    const diff = (a[key] ?? 0) - (b[key] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** True if `a` is at least as good as `b` on every key and strictly better on at least one. */
export const paretoDominates = (
  a: MetricComponents,
  b: MetricComponents,
  keys: string[],
): boolean => {
  let strictlyBetterSomewhere = false;
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
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
): T[] =>
  candidates.filter((candidate) => {
    const metrics = metricsOf(candidate);
    return !candidates.some(
      (other) =>
        other !== candidate && paretoDominates(metricsOf(other), metrics, keys),
    );
  });
