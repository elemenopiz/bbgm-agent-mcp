#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildEvaluationReport,
  type EvaluationReport,
  type EvaluationResult,
} from "../src/research/evaluate.js";
import { evaluateReward } from "../src/research/objectives.js";
import { loadScenarioManifest } from "../src/research/scenario.js";

const root = resolve(import.meta.dirname, "..");

const main = async (): Promise<void> => {
  const inputPath = resolve(
    root,
    process.argv[2] ??
      ".data/grant-ready-final-v9/long-horizon-asset-preservation-v1.json",
  );
  const outputPath = resolve(
    root,
    process.argv[3] ??
      ".data/grant-ready-final-v9/long-horizon-asset-preservation-v1-stats.json",
  );
  const input = JSON.parse(
    await readFile(inputPath, "utf8"),
  ) as EvaluationReport;
  const scenario = await loadScenarioManifest(
    resolve(root, "scenarios/long-horizon-asset-preservation.json"),
  );
  const results: EvaluationResult[] = input.results.map((result) => {
    const attempts = result.trajectorySummary.agentAttemptCount;
    const seasons = result.terminalMetrics.seasonsCompleted;
    const metricComponents = {
      ...result.metricComponents,
      decision_efficiency: attempts === 0 ? 0 : seasons / attempts,
      agent_attempts_per_completed_season:
        seasons === 0 ? 0 : attempts / seasons,
    };
    return {
      ...result,
      metricComponents,
      reward: evaluateReward(metricComponents, scenario.reward),
    };
  });
  const report = buildEvaluationReport({
    scenario,
    results,
    generatedAt: new Date().toISOString(),
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`grant-report-upgrade: wrote ${outputPath}`);
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `grant-report-upgrade: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
