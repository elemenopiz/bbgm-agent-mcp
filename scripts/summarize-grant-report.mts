#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

type JsonRecord = Record<string, unknown>;

type ScenarioSummary = {
  scenarioId: string;
  seeds: string[];
  rewardMode: string;
};

type ResultSummary = {
  policyName: string;
  seed: string;
  completionStatus: string;
  stepsTaken: number;
  rollbackCount: number;
  metrics: Record<string, number>;
};

type PolicySummary = {
  policyName: string;
  runCount: number;
  completed: number;
  budgetExhausted: number;
  stalled: number;
  means: Record<string, number>;
  metricSummaries: Record<string, NumericSummary>;
};

type NumericSummary = {
  count: number;
  mean: number;
  standardDeviation: number;
  minimum: number;
  maximum: number;
};

type AggregateSummary = {
  policyName: string;
  runCount: number;
  metricComponents: Record<string, number>;
  metricSummaries: Record<string, NumericSummary>;
};

type ProvenanceSummary = {
  scenarioFingerprint: string;
  wrapperVersion: string;
  engineIdentities: JsonRecord[];
};

type GrantSummary = {
  schemaVersion: "grant-evidence-summary.v1";
  scenario: ScenarioSummary;
  policies: string[];
  resultCount: number;
  policySummaries: PolicySummary[];
  results: ResultSummary[];
  comparison: JsonRecord;
  statistics?: JsonRecord;
  provenance: ProvenanceSummary;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const finiteNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
};

const nonNegativeInteger = (value: unknown, label: string): number => {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
};

const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item, index) =>
    stringValue(item, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return values;
};

const metricRecord = (
  value: unknown,
  label: string,
): Record<string, number> => {
  const input = record(value, label);
  return Object.fromEntries(
    Object.entries(input).map(([key, metric]) => [
      key,
      finiteNumber(metric, `${label}.${key}`),
    ]),
  );
};

const numericSummaryRecord = (
  value: unknown,
  label: string,
): Record<string, NumericSummary> => {
  const input = record(value, label);
  return Object.fromEntries(
    Object.entries(input).map(([key, candidate]) => {
      const summary = record(candidate, `${label}.${key}`);
      const parsed: NumericSummary = {
        count: nonNegativeInteger(summary["count"], `${label}.${key}.count`),
        mean: finiteNumber(summary["mean"], `${label}.${key}.mean`),
        standardDeviation: finiteNumber(
          summary["standardDeviation"],
          `${label}.${key}.standardDeviation`,
        ),
        minimum: finiteNumber(summary["minimum"], `${label}.${key}.minimum`),
        maximum: finiteNumber(summary["maximum"], `${label}.${key}.maximum`),
      };
      if (parsed.count === 0 || parsed.standardDeviation < 0) {
        throw new Error(`${label}.${key} contains an invalid sample summary`);
      }
      if (parsed.minimum > parsed.maximum) {
        throw new Error(`${label}.${key} minimum exceeds maximum`);
      }
      if (parsed.mean < parsed.minimum || parsed.mean > parsed.maximum) {
        throw new Error(`${label}.${key} mean is outside its range`);
      }
      return [key, parsed];
    }),
  );
};

const sorted = (values: Iterable<string>): string[] =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const validateReport = (
  value: unknown,
): {
  scenario: ScenarioSummary;
  results: ResultSummary[];
  aggregates: AggregateSummary[];
  comparison: JsonRecord;
  statistics?: JsonRecord;
  provenance: ProvenanceSummary;
} => {
  const input = record(value, "report");
  if (input["reportVersion"] !== 1) {
    throw new Error("report.reportVersion must be 1");
  }

  const scenarioInput = record(input["scenario"], "report.scenario");
  const scenario: ScenarioSummary = {
    scenarioId: stringValue(
      scenarioInput["scenarioId"],
      "report.scenario.scenarioId",
    ),
    seeds: stringArray(scenarioInput["seedSet"], "report.scenario.seedSet"),
    rewardMode: stringValue(
      record(input["reward"], "report.reward")["mode"],
      "report.reward.mode",
    ),
  };
  if (scenario.seeds.length === 0) {
    throw new Error("report.scenario.seedSet must not be empty");
  }

  const resultsInput = input["results"];
  if (!Array.isArray(resultsInput) || resultsInput.length === 0) {
    throw new Error("report.results must be a non-empty array");
  }
  const results = resultsInput.map((item, index) => {
    const result = record(item, `report.results[${index}]`);
    const completionStatus = stringValue(
      result["completionStatus"],
      `report.results[${index}].completionStatus`,
    );
    if (
      !["completed", "budget_exhausted", "stalled"].includes(completionStatus)
    ) {
      throw new Error(
        `report.results[${index}].completionStatus is unsupported`,
      );
    }
    const trajectorySummary = record(
      result["trajectorySummary"],
      `report.results[${index}].trajectorySummary`,
    );
    return {
      policyName: stringValue(
        result["policyName"],
        `report.results[${index}].policyName`,
      ),
      seed: stringValue(result["seed"], `report.results[${index}].seed`),
      completionStatus,
      stepsTaken: nonNegativeInteger(
        result["stepsTaken"],
        `report.results[${index}].stepsTaken`,
      ),
      rollbackCount:
        trajectorySummary["rollbackCount"] === undefined
          ? 0
          : nonNegativeInteger(
              trajectorySummary["rollbackCount"],
              `report.results[${index}].trajectorySummary.rollbackCount`,
            ),
      metrics: metricRecord(
        result["metricComponents"],
        `report.results[${index}].metricComponents`,
      ),
    };
  });

  const policyNames = sorted(
    new Set(results.map((result) => result.policyName)),
  );
  if (!policyNames.includes("no_op") || !policyNames.includes("heuristic")) {
    throw new Error(
      "report must include both no_op and heuristic reference baselines",
    );
  }
  const expectedKeys = new Set(
    policyNames.flatMap((policy) =>
      scenario.seeds.map((seed) => `${policy}:${seed}`),
    ),
  );
  const actualKeys = results.map(
    (result) => `${result.policyName}:${result.seed}`,
  );
  if (results.length !== expectedKeys.size) {
    throw new Error(
      `report.results must contain exactly one result for each of ${expectedKeys.size} policy/seed pairs`,
    );
  }
  if (
    new Set(actualKeys).size !== actualKeys.length ||
    actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error(
      "report.results has duplicate or undeclared policy/seed data",
    );
  }

  const aggregatesInput = input["aggregates"];
  if (!Array.isArray(aggregatesInput)) {
    throw new Error("report.aggregates must be an array");
  }
  const aggregates: AggregateSummary[] = aggregatesInput.map((item, index) => {
    const aggregate = record(item, `report.aggregates[${index}]`);
    const metricComponents = metricRecord(
      aggregate["metricComponents"],
      `aggregate ${index}.metricComponents`,
    );
    const metricSummaries = numericSummaryRecord(
      aggregate["metricSummaries"],
      `aggregate ${index}.metricSummaries`,
    );
    if (
      JSON.stringify(Object.keys(metricComponents).sort()) !==
      JSON.stringify(Object.keys(metricSummaries).sort())
    ) {
      throw new Error(
        `aggregate ${index} metric components and summaries have different keys`,
      );
    }
    return {
      policyName: stringValue(
        aggregate["policyName"],
        `report.aggregates[${index}].policyName`,
      ),
      runCount: nonNegativeInteger(
        aggregate["runCount"],
        `report.aggregates[${index}].runCount`,
      ),
      metricComponents,
      metricSummaries,
    };
  });
  if (
    new Set(aggregates.map((aggregate) => aggregate.policyName)).size !==
    aggregates.length
  ) {
    throw new Error("report.aggregates must not contain duplicate policies");
  }
  if (aggregates.length !== policyNames.length) {
    throw new Error("report.aggregates must contain one entry per policy");
  }
  for (const policy of policyNames) {
    const aggregate = aggregates.find(
      (candidate) => candidate.policyName === policy,
    );
    if (!aggregate) throw new Error(`Missing aggregate for policy ${policy}`);
    if (aggregate.runCount !== scenario.seeds.length) {
      throw new Error(
        `Aggregate for policy ${policy} has incomplete seed coverage`,
      );
    }
    for (const [metric, summary] of Object.entries(aggregate.metricSummaries)) {
      if (summary.count !== scenario.seeds.length) {
        throw new Error(
          `Aggregate for policy ${policy}, metric ${metric} has incomplete seed coverage`,
        );
      }
    }
  }

  const comparison = record(input["comparison"], "report.comparison");
  if (comparison["mode"] !== scenario.rewardMode) {
    throw new Error("report.comparison.mode does not match report.reward.mode");
  }
  const comparisonIds =
    comparison["rankedEpisodeIds"] ?? comparison["frontierEpisodeIds"];
  if (!Array.isArray(comparisonIds) || comparisonIds.length === 0) {
    throw new Error("report.comparison must contain non-empty comparison IDs");
  }
  const statistics =
    input["statistics"] === undefined
      ? undefined
      : record(input["statistics"], "report.statistics");

  const provenance = record(input["provenance"], "report.provenance");
  stringValue(
    provenance["scenarioFingerprint"],
    "report.provenance.scenarioFingerprint",
  );
  stringValue(provenance["wrapperVersion"], "report.provenance.wrapperVersion");
  const declaredSeeds = stringArray(
    provenance["declaredSeeds"],
    "report.provenance.declaredSeeds",
  );
  if (
    JSON.stringify(declaredSeeds) !== JSON.stringify(sorted(scenario.seeds))
  ) {
    throw new Error(
      "report.provenance.declaredSeeds does not match scenario.seedSet",
    );
  }
  const evaluatedSeeds = stringArray(
    provenance["evaluatedSeeds"],
    "report.provenance.evaluatedSeeds",
  );
  if (
    JSON.stringify(evaluatedSeeds) !== JSON.stringify(sorted(scenario.seeds))
  ) {
    throw new Error(
      "report.provenance.evaluatedSeeds does not cover all scenario seeds",
    );
  }
  const engineIdentitiesInput = provenance["engineIdentities"];
  if (
    !Array.isArray(engineIdentitiesInput) ||
    engineIdentitiesInput.length === 0
  ) {
    throw new Error("report.provenance.engineIdentities must not be empty");
  }
  const engineIdentities = engineIdentitiesInput.map((item, index) =>
    record(item, `report.provenance.engineIdentities[${index}]`),
  );

  return {
    scenario,
    results,
    aggregates,
    comparison,
    ...(statistics === undefined ? {} : { statistics }),
    provenance: {
      scenarioFingerprint: stringValue(
        provenance["scenarioFingerprint"],
        "report.provenance.scenarioFingerprint",
      ),
      wrapperVersion: stringValue(
        provenance["wrapperVersion"],
        "report.provenance.wrapperVersion",
      ),
      engineIdentities,
    },
  };
};

const displayNumber = (value: number): string =>
  Number.isFinite(value) ? value.toFixed(4) : "n/a";

const markdownCell = (value: string): string => value.replaceAll("|", "\\|");

const buildSummary = (
  scenario: ScenarioSummary,
  results: ResultSummary[],
  aggregates: AggregateSummary[],
  comparison: JsonRecord,
  statistics: JsonRecord | undefined,
  provenance: ProvenanceSummary,
): GrantSummary => {
  const policies = sorted(new Set(results.map((result) => result.policyName)));
  return {
    schemaVersion: "grant-evidence-summary.v1",
    scenario,
    policies,
    resultCount: results.length,
    policySummaries: policies.map((policyName) => {
      const policyResults = results.filter(
        (result) => result.policyName === policyName,
      );
      const aggregate = aggregates.find(
        (candidate) => candidate.policyName === policyName,
      );
      if (aggregate === undefined) {
        throw new Error(`Missing aggregate for policy ${policyName}`);
      }
      return {
        policyName,
        runCount: policyResults.length,
        completed: policyResults.filter(
          (result) => result.completionStatus === "completed",
        ).length,
        budgetExhausted: policyResults.filter(
          (result) => result.completionStatus === "budget_exhausted",
        ).length,
        stalled: policyResults.filter(
          (result) => result.completionStatus === "stalled",
        ).length,
        means: aggregate.metricComponents,
        metricSummaries: aggregate.metricSummaries,
      };
    }),
    results: [...results].sort((a, b) => {
      const policy =
        a.policyName < b.policyName ? -1 : a.policyName > b.policyName ? 1 : 0;
      return policy !== 0
        ? policy
        : a.seed < b.seed
          ? -1
          : a.seed > b.seed
            ? 1
            : 0;
    }),
    comparison,
    ...(statistics === undefined ? {} : { statistics }),
    provenance,
  };
};

const toMarkdown = (summary: GrantSummary): string => {
  const lines = [
    "# Grant evidence summary",
    "",
    `Scenario: ${markdownCell(summary.scenario.scenarioId)}`,
    `Seeds: ${summary.scenario.seeds.length}`,
    `Policies: ${summary.policies.map(markdownCell).join(", ")}`,
    `Reward mode: ${markdownCell(summary.scenario.rewardMode)}`,
    `Results: ${summary.resultCount}`,
    "",
    "This is an integrity-preserving summary of the evaluator report. It does not claim open-model competence or Tinker improvement.",
    "",
    "## Policy aggregates",
    "",
    "| Policy | Runs | Completed | Budget exhausted | Stalled | Win % mean | Asset value mean | Invalid action mean | Stale action mean |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const policy of summary.policySummaries) {
    lines.push(
      `| ${markdownCell(policy.policyName)} | ${policy.runCount} | ${policy.completed} | ${policy.budgetExhausted} | ${policy.stalled} | ${displayNumber(policy.means["win_pct"] ?? Number.NaN)} | ${displayNumber(policy.means["total_asset_value"] ?? Number.NaN)} | ${displayNumber(policy.means["invalid_action_rate"] ?? Number.NaN)} | ${displayNumber(policy.means["stale_action_rate"] ?? Number.NaN)} |`,
    );
  }
  lines.push(
    "",
    "## Aggregate metric statistics",
    "",
    "The evaluator reports population standard deviation across the declared seed set; no missing runs are silently imputed.",
    "",
    "| Policy | Metric | n | Mean | Std. dev. | Minimum | Maximum |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const policy of summary.policySummaries) {
    for (const metric of Object.keys(policy.metricSummaries).sort()) {
      const stats = policy.metricSummaries[metric]!;
      lines.push(
        `| ${markdownCell(policy.policyName)} | ${markdownCell(metric)} | ${stats.count} | ${displayNumber(stats.mean)} | ${displayNumber(stats.standardDeviation)} | ${displayNumber(stats.minimum)} | ${displayNumber(stats.maximum)} |`,
      );
    }
  }
  if (summary.statistics !== undefined) {
    const pairs = Array.isArray(summary.statistics["pairs"])
      ? summary.statistics["pairs"]
      : [];
    lines.push(
      "",
      "## Paired policy effects",
      "",
      "Treatment minus comparator; intervals use the report's declared paired normal approximation and retain stalled runs.",
      "",
      "| Treatment | Comparator | Metric | n | Mean delta | 95% CI | Cohen's dz |",
      "| --- | --- | --- | ---: | ---: | --- | ---: |",
    );
    for (const pairValue of pairs) {
      if (!isRecord(pairValue)) continue;
      const effects = Array.isArray(pairValue["effects"])
        ? pairValue["effects"]
        : [];
      for (const effectValue of effects) {
        if (!isRecord(effectValue)) continue;
        const interval = isRecord(effectValue["confidenceInterval95"])
          ? effectValue["confidenceInterval95"]
          : {};
        lines.push(
          `| ${markdownCell(String(pairValue["treatment"]))} | ${markdownCell(String(pairValue["comparator"]))} | ${markdownCell(String(effectValue["metric"]))} | ${String(effectValue["n"])} | ${displayNumber(Number(effectValue["meanDelta"]))} | [${displayNumber(Number(interval["lower"]))}, ${displayNumber(Number(interval["upper"]))}] | ${effectValue["cohensDz"] === null ? "n/a" : displayNumber(Number(effectValue["cohensDz"]))} |`,
        );
      }
    }
  }
  lines.push(
    "",
    "## Per-seed outcomes",
    "",
    "| Policy | Seed | Status | Steps | Rollbacks | Win % | Total asset value | Hard violations | Invalid actions | Stale actions |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const result of summary.results) {
    lines.push(
      `| ${markdownCell(result.policyName)} | ${markdownCell(result.seed)} | ${result.completionStatus} | ${result.stepsTaken} | ${result.rollbackCount} | ${displayNumber(result.metrics["win_pct"] ?? Number.NaN)} | ${displayNumber(result.metrics["total_asset_value"] ?? Number.NaN)} | ${displayNumber(result.metrics["hard_constraint_violations"] ?? Number.NaN)} | ${displayNumber(result.metrics["invalid_action_rate"] ?? Number.NaN)} | ${displayNumber(result.metrics["stale_action_rate"] ?? Number.NaN)} |`,
    );
  }
  lines.push(
    "",
    "## Provenance",
    "",
    `- Wrapper version: \`${markdownCell(summary.provenance.wrapperVersion)}\``,
    `- Scenario fingerprint: \`${markdownCell(summary.provenance.scenarioFingerprint)}\``,
    `- Engine identities recorded: ${summary.provenance.engineIdentities.length}`,
    `- Comparison mode: \`${markdownCell(String(summary.comparison["mode"]))}\``,
    ...(typeof summary.comparison["completionRule"] === "string"
      ? [
          `- Completion rule: \`${markdownCell(String(summary.comparison["completionRule"]))}\``,
        ]
      : []),
    "",
  );
  return `${lines.join("\n")}\n`;
};

const usage = (): void => {
  console.error(
    `Usage: node scripts/summarize-grant-report.mts --report <path> [--format markdown|json] [--out <path>]`,
  );
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      format: { type: "string", default: "markdown" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    usage();
    return;
  }
  if (!values.report) throw new Error("--report is required");
  if (values.format !== "markdown" && values.format !== "json") {
    throw new Error("--format must be markdown or json");
  }
  const report = JSON.parse(
    await readFile(resolve(values.report), "utf8"),
  ) as unknown;
  const validated = validateReport(report);
  const summary = buildSummary(
    validated.scenario,
    validated.results,
    validated.aggregates,
    validated.comparison,
    validated.statistics,
    validated.provenance,
  );
  const output =
    values.format === "json"
      ? `${JSON.stringify(summary, null, 2)}\n`
      : toMarkdown(summary);
  if (values.out) {
    const outputPath = resolve(values.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `grant-report: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
