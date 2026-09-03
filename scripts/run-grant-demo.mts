#!/usr/bin/env -S node --experimental-strip-types

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const scenarioPath = resolve(
  root,
  "scenarios/long-horizon-asset-preservation.json",
);
const defaultDataRoot = resolve(root, ".data/grant-demo");
const defaultOutputPath = resolve(
  defaultDataRoot,
  "long-horizon-asset-preservation-v1.json",
);
const defaultSummaryPath = resolve(defaultDataRoot, "reviewer-summary.md");

const CANONICAL_SCENARIO_ID = "long-horizon-asset-preservation-v1";
const CANONICAL_SEEDS = [
  "grant-seed-001",
  "grant-seed-002",
  "grant-seed-003",
  "grant-seed-004",
  "grant-seed-005",
] as const;

type CanonicalScenario = {
  scenarioId: string;
  seedSet: string[];
};

type ReportShape = {
  scenario?: { scenarioId?: unknown };
  comparison?: unknown;
  results?: {
    policyName?: unknown;
    seed?: unknown;
  }[];
};

const printUsage = (): void => {
  console.error(`Usage: node scripts/run-grant-demo.mts [options]

Runs the canonical deterministic reference-policy pilot and writes its
machine-readable evaluator report.

Options:
  --data-root <path>  Episode logs and snapshots (default: .data/grant-demo)
  --out <path>        JSON report path (default: .data/grant-demo/long-horizon-asset-preservation-v1.json)
  --summary-out <path> Markdown reviewer summary (default: .data/grant-demo/reviewer-summary.md)
  --help              Show this help`);
};

const fail = (message: string): never => {
  throw new Error(message);
};

const runPnpm = (args: string[], env: NodeJS.ProcessEnv): void => {
  execFileSync("pnpm", args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item): item is string => typeof item === "string");

const readCanonicalScenario = async (): Promise<CanonicalScenario> => {
  const parsed: unknown = JSON.parse(await readFile(scenarioPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    fail(`canonical scenario is not the expected manifest at ${scenarioPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const scenarioId = record["scenarioId"];
  const rawSeedSet = record["seedSet"];
  const canonicalSeedSet = isStringArray(rawSeedSet)
    ? rawSeedSet
    : fail(
        `canonical scenario is not the expected manifest at ${scenarioPath}`,
      );
  if (
    scenarioId !== CANONICAL_SCENARIO_ID ||
    canonicalSeedSet.length !== CANONICAL_SEEDS.length ||
    canonicalSeedSet.some((seed, index) => seed !== CANONICAL_SEEDS[index])
  ) {
    fail(`canonical scenario is not the expected manifest at ${scenarioPath}`);
  }
  return {
    scenarioId: CANONICAL_SCENARIO_ID,
    seedSet: [...CANONICAL_SEEDS],
  };
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      "data-root": { type: "string" },
      out: { type: "string" },
      "summary-out": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const sourceDir =
    process.env["BBGM_SOURCE_DIR"] ??
    fail(
      "BBGM_SOURCE_DIR is not set. Provide a separately obtained Basketball GM / zengm checkout at the pinned version before running the pilot.",
    );

  const dataRoot = resolve(root, values["data-root"] ?? defaultDataRoot);
  const outputPath = resolve(root, values.out ?? defaultOutputPath);
  const summaryPath = resolve(
    root,
    values["summary-out"] ?? defaultSummaryPath,
  );
  const scenario = await readCanonicalScenario();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BBGM_SOURCE_DIR: resolve(sourceDir),
  };

  console.error("grant-demo: verifying the pinned Basketball GM checkout...");
  runPnpm(["engine:verify"], env);
  console.error("grant-demo: building the headless engine bridge...");
  runPnpm(["engine:build"], env);
  console.error(
    `grant-demo: evaluating ${scenario.seedSet.length} seed(s) with no_op and heuristic...`,
  );
  runPnpm(
    [
      "research:evaluate",
      "--scenario",
      scenarioPath,
      "--policy",
      "all",
      "--data-root",
      dataRoot,
      "--out",
      outputPath,
    ],
    env,
  );

  const report = JSON.parse(await readFile(outputPath, "utf8")) as ReportShape;
  const results = report.results ?? [];
  const expectedPolicies = ["heuristic", "no_op"];
  const expectedKeys = new Set(
    expectedPolicies.flatMap((policy) =>
      scenario.seedSet.map((seed) => `${policy}:${seed}`),
    ),
  );
  const actualKeys = results.map(
    (result) => `${String(result.policyName)}:${String(result.seed)}`,
  );
  if (
    report.scenario?.scenarioId !== scenario.scenarioId ||
    report.comparison === undefined ||
    results.length !== expectedKeys.size ||
    new Set(actualKeys).size !== expectedKeys.size ||
    actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    fail(
      `the evaluator report at ${outputPath} did not contain exactly one result for each supported policy and canonical seed`,
    );
  }

  console.error(
    "grant-demo: verifying report, metadata, and episode audit logs...",
  );
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      resolve(root, "scripts/verify-grant-artifact.mts"),
      "--report",
      outputPath,
      "--data-root",
      dataRoot,
    ],
    { cwd: root, env, stdio: "inherit" },
  );

  console.error(
    "grant-demo: validating and summarizing the complete report...",
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, "scripts/summarize-grant-report.mts"),
      "--report",
      outputPath,
      "--format",
      "markdown",
      "--out",
      summaryPath,
    ],
    { cwd: root, env, stdio: "inherit" },
  );

  console.error(`grant-demo: report verified at ${outputPath}`);
  console.error(`grant-demo: reviewer summary written at ${summaryPath}`);
  console.error(
    `grant-demo: ${results.length} run(s), policies=${expectedPolicies.join(",")}, seeds=${scenario.seedSet.length}`,
  );
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `grant-demo: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
