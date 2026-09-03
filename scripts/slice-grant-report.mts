#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildEvaluationReport,
  type EvaluationReport,
  type EvaluationResult,
} from "../src/research/evaluate.js";
import { loadScenarioManifest } from "../src/research/scenario.js";

const root = resolve(import.meta.dirname, "..");

const main = async (): Promise<void> => {
  const inputPath = resolve(root, process.argv[2] ?? "");
  const scenarioPath = resolve(root, process.argv[3] ?? "");
  const outputPath = resolve(root, process.argv[4] ?? "");
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
    throw new Error(
      "Usage: node scripts/slice-grant-report.mts <report> <scenario> <out>",
    );
  }
  const input = JSON.parse(
    await readFile(inputPath, "utf8"),
  ) as EvaluationReport;
  const scenario = await loadScenarioManifest(scenarioPath);
  const declaredSeeds = new Set(scenario.seedSet);
  const results: EvaluationResult[] = input.results
    .filter((result) => declaredSeeds.has(result.seed))
    .map((result) => ({ ...result, scenarioId: scenario.scenarioId }));
  if (results.length !== scenario.seedSet.length * 2) {
    throw new Error(
      `Expected no_op and heuristic for each of ${scenario.seedSet.length} seeds, found ${results.length} results`,
    );
  }
  const report = buildEvaluationReport({ scenario, results });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`grant-report-slice: wrote ${outputPath}`);
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `grant-report-slice: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
