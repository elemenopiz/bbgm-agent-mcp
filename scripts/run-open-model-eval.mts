/**
 * Run a real external/open-model PolicyAdapter through the canonical evaluator.
 *
 * The model client stays out of this repository's core: callers provide a
 * local adapter module that translates one bounded AgentObservation into one
 * typed PolicyStepContext action. This keeps provider credentials, prompts,
 * checkpoints, and model-specific code outside the MCP/evaluation boundary.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { DomainService } from "../src/domain/DomainService.js";
import {
  BASKETBALL_GM_ENGINE_METADATA,
  BasketballGmEngine,
} from "../src/engine/bbgm/BasketballGmEngine.js";
import {
  buildEvaluationReport,
  runEvaluation,
  type PolicyAdapter,
  type EvaluationResult,
  type PolicyName,
} from "../src/research/evaluate.js";
import { loadScenarioManifest } from "../src/research/scenario.js";
import { createFileSnapshotStore } from "../src/persistence/snapshots.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";

type AdapterFactory = (input: {
  policyName: PolicyName;
  seed: string;
}) => PolicyAdapter | Promise<PolicyAdapter>;

const POLICY_NAMES: readonly PolicyName[] = [
  "no_op",
  "heuristic",
  "untrained_open_model",
  "prompted_open_model",
  "fine_tuned_model",
  "frontier_reference_model",
  "tinker",
];

const usage =
  (): string => `Usage: pnpm research:open-model --scenario <manifest.json> --adapter <module> [options]

Required:
  --scenario <path>   Scenario manifest used by the canonical evaluator
  --adapter <path>    Local ESM module exporting createPolicyAdapter(input)

Options:
  --policy <name>      Adapter identity (default: untrained_open_model)
  --seed <seed>        Run one seed instead of the manifest seed set
  --model-only         Do not include the unchanged no_op and heuristic controls
  --data-root <path>   Episode logs and snapshots (default: .data)
  --out <path>         Evaluation report JSON (default: stdout)

The adapter module must return a PolicyAdapter whose metadata.name matches
--policy. It receives only the typed PolicyStepContext at evaluation time;
provider credentials and model code remain in that module.`;

const requiredString = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required --${name}\n\n${usage()}`);
  }
  return value;
};

const isPolicyName = (value: string): value is PolicyName =>
  POLICY_NAMES.includes(value as PolicyName);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const loadAdapterFactory = async (
  modulePath: string,
): Promise<AdapterFactory> => {
  const module = (await import(pathToFileURL(modulePath).href)) as {
    createPolicyAdapter?: unknown;
    default?: unknown;
  };
  const candidate = module.createPolicyAdapter ?? module.default;
  if (typeof candidate !== "function") {
    throw new Error(
      `Adapter module ${modulePath} must export createPolicyAdapter(input) or a default factory`,
    );
  }
  return candidate as AdapterFactory;
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      adapter: { type: "string" },
      policy: { type: "string", default: "untrained_open_model" },
      seed: { type: "string" },
      "model-only": { type: "boolean", default: false },
      "data-root": { type: "string", default: ".data" },
      out: { type: "string" },
    },
  });

  const scenarioPath = resolve(requiredString(values.scenario, "scenario"));
  const adapterPath = resolve(requiredString(values.adapter, "adapter"));
  const policyValue = requiredString(values.policy, "policy");
  if (!isPolicyName(policyValue)) {
    throw new Error(
      `unsupported --policy ${policyValue}; expected one of ${POLICY_NAMES.join(", ")}`,
    );
  }

  const scenario = await loadScenarioManifest(scenarioPath);
  const adapterFactory = await loadAdapterFactory(adapterPath);
  let initialSnapshot: unknown;
  let initialSnapshotHash: string | undefined;
  if (scenario.initialSnapshotPath !== undefined) {
    const snapshotPath = resolve(
      dirname(scenarioPath),
      scenario.initialSnapshotPath,
    );
    const snapshotRaw = await readFile(snapshotPath, "utf8");
    initialSnapshot = JSON.parse(snapshotRaw) as unknown;
    initialSnapshotHash = sha256(snapshotRaw);
  }

  const dataRoot = resolve(values["data-root"] ?? ".data");
  await mkdir(dataRoot, { recursive: true });
  const traceRoot = resolve(
    process.env["BBGM_MODEL_TRACE_DIR"] ?? resolve(dataRoot, "traces"),
  );
  process.env["BBGM_MODEL_TRACE_DIR"] = traceRoot;
  const seeds = values.seed === undefined ? scenario.seedSet : [values.seed];
  const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
  const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));

  try {
    const results: EvaluationResult[] = [];
    const policyNames: PolicyName[] = values["model-only"]
      ? [policyValue]
      : ["no_op", "heuristic", policyValue];
    for (const seed of seeds) {
      for (const currentPolicy of policyNames) {
        const adapter =
          currentPolicy === policyValue
            ? await adapterFactory({ policyName: policyValue, seed })
            : undefined;
        results.push(
          await runEvaluation({
            scenario,
            seed,
            policyName: currentPolicy,
            ...(adapter === undefined ? {} : { policyAdapter: adapter }),
            domain,
            dataRoot,
            engineMetadata: BASKETBALL_GM_ENGINE_METADATA,
            ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
            ...(initialSnapshotHash === undefined
              ? {}
              : { initialSnapshotHash }),
          }),
        );
      }
    }

    const report = buildEvaluationReport({
      scenario,
      results,
      ...(initialSnapshotHash === undefined ? {} : { initialSnapshotHash }),
    });
    const output = JSON.stringify(report, null, 2);
    if (values.out === undefined) {
      process.stdout.write(`${output}\n`);
    } else {
      const outputPath = resolve(values.out);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${output}\n`, "utf8");
      process.stderr.write(`open-model-eval: wrote ${outputPath}\n`);
    }
    const firstModelResult = results.find(
      (result) => result.policyName === policyValue,
    );
    await writeFile(
      resolve(dataRoot, "open-model-run-manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: "open-model-run.v1",
          generatedAt: new Date().toISOString(),
          commandLine: process.argv.join(" "),
          scenarioPath,
          scenarioId: scenario.scenarioId,
          declaredSeeds: scenario.seedSet,
          evaluatedSeeds: seeds,
          adapterPath,
          adapterSha256: sha256(await readFile(adapterPath, "utf8")),
          traceRoot,
          reportPath: values.out === undefined ? null : resolve(values.out),
          model: firstModelResult?.adapter ?? null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stderr.write(
      `open-model-eval: run manifest written ${resolve(dataRoot, "open-model-run-manifest.json")}\n`,
    );
  } finally {
    await domain.closeAll();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `open-model-eval: FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
