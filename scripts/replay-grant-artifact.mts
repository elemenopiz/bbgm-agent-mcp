#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DomainService } from "../src/domain/DomainService.js";
import {
  advanceInputSchema,
  makeDraftPickInputSchema,
  negotiateContractInputSchema,
  releasePlayerInputSchema,
  setLineupInputSchema,
  signFreeAgentInputSchema,
  tradeProposalSchema,
} from "../src/domain/schemas.js";
import type { MutationContext } from "../src/domain/types.js";
import {
  BASKETBALL_GM_ENGINE_METADATA,
  BasketballGmEngine,
} from "../src/engine/bbgm/BasketballGmEngine.js";
import { createFileSnapshotStore } from "../src/persistence/snapshots.js";
import { readTrajectory } from "../src/research/trajectory.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";
import type { TrajectoryRecord } from "../src/persistence/trajectoryLog.js";

const root = resolve(import.meta.dirname, "..");

type ReportResult = {
  episodeId?: unknown;
  policyName?: unknown;
  seed?: unknown;
};

type ReportShape = { results?: ReportResult[] };

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

type ReplayEpisodeResult = {
  sourceEpisodeId: string;
  replayEpisodeId: string;
  policyName: string | null;
  seed: string;
  trajectoryRecords: number;
  acceptedMutations: number;
  rollbackRecords: number;
  status: "verified";
};

type ReplayManifest = {
  schemaVersion: "grant-replay.v1";
  generatedAt: string;
  command: string;
  sourceReport: string;
  sourceDataRoot: string;
  provenance: {
    gitCommit: string;
    workingTreeClean: boolean;
    nodeVersion: string;
    pnpmVersion: string;
    lockfileSha256: string;
    engine: typeof BASKETBALL_GM_ENGINE_METADATA;
    sourceFiles: { path: string; bytes: number; sha256: string }[];
  };
  episodes: ReplayEpisodeResult[];
};

class ReplayMismatchError extends Error {
  constructor(
    public readonly sourceEpisodeId: string,
    public readonly sequence: number,
    public readonly step: TrajectoryRecord["step"],
    message: string,
  ) {
    super(`${sourceEpisodeId} sequence ${sequence} (${step}): ${message}`);
    this.name = "ReplayMismatchError";
  }
}

const usage = (): void => {
  console.error(`Usage: pnpm research:replay --report <path> --data-root <path> [--out <path>]

Replays every recorded trajectory through a fresh real-engine episode and
compares the recorded state hash at every create, mutation, rollback, and end
boundary. BBGM_SOURCE_DIR must point to the separately obtained pinned engine
checkout, and the bridge must already have been built.`);
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const stripType = (
  action: Record<string, unknown>,
): Record<string, unknown> => {
  const { type: _type, ...payload } = action;
  return payload;
};

const contextFor = (
  expectedRevision: number,
  sourceEpisodeId: string,
  sequence: number,
): MutationContext => ({
  expectedRevision,
  idempotencyKey: `replay-${sourceEpisodeId}-${sequence}`.slice(0, 100),
});

const applyNormalizedAction = async (
  domain: DomainService,
  episodeId: string,
  record: TrajectoryRecord,
  checkpointIds: Map<string, string>,
): Promise<unknown> => {
  const action = record.normalizedAction;
  const type = action["type"];
  if (type === "create_checkpoint") {
    const checkpoint = await domain.createCheckpoint(episodeId);
    const sourceCheckpointId = action["checkpointId"];
    if (typeof sourceCheckpointId !== "string") {
      throw new Error("create_checkpoint trajectory record lacks checkpointId");
    }
    checkpointIds.set(sourceCheckpointId, checkpoint.checkpointId);
    return checkpoint;
  }
  const expectedRevision =
    record.step === "rollback" ? record.revision : record.revision - 1;
  const context = contextFor(
    expectedRevision,
    record.episodeId,
    record.sequence,
  );
  const payload = stripType(action);

  switch (type) {
    case "advance":
      return domain.advance(
        episodeId,
        advanceInputSchema.parse(payload),
        context,
      );
    case "execute_trade":
      return domain.executeTrade(
        episodeId,
        tradeProposalSchema.parse(payload),
        context,
      );
    case "set_lineup":
      return domain.setLineup(
        episodeId,
        setLineupInputSchema.parse(payload),
        context,
      );
    case "release_player":
      return domain.releasePlayer(
        episodeId,
        releasePlayerInputSchema.parse(payload),
        context,
      );
    case "negotiate_contract":
      return domain.negotiateContract(
        episodeId,
        negotiateContractInputSchema.parse(payload),
        context,
      );
    case "sign_free_agent":
      return domain.signFreeAgent(
        episodeId,
        signFreeAgentInputSchema.parse(payload),
        context,
      );
    case "make_draft_pick":
      return domain.makeDraftPick(
        episodeId,
        makeDraftPickInputSchema.parse(payload),
        context,
      );
    case "restore_checkpoint": {
      const sourceCheckpointId = payload["checkpointId"];
      if (typeof sourceCheckpointId !== "string") {
        throw new Error(
          "restore_checkpoint trajectory record lacks checkpointId",
        );
      }
      const replayCheckpointId = checkpointIds.get(sourceCheckpointId);
      if (replayCheckpointId === undefined) {
        throw new Error(
          `restore references unknown checkpoint ${sourceCheckpointId}`,
        );
      }
      return domain.restoreCheckpoint(episodeId, replayCheckpointId, context);
    }
    default:
      throw new Error(`Unsupported replay action type: ${String(type)}`);
  }
};

const assertHash = async (
  domain: DomainService,
  replayEpisodeId: string,
  source: TrajectoryRecord,
  expected: string,
): Promise<void> => {
  const overview = await domain.getStateForEvaluation({
    episodeId: replayEpisodeId,
    view: "overview",
  });
  if (overview.stateHash !== expected) {
    throw new ReplayMismatchError(
      source.episodeId,
      source.sequence,
      source.step,
      `expected state hash ${expected}, got ${overview.stateHash}`,
    );
  }
};

const replayEpisode = async (
  dataRoot: string,
  sourceEpisodeId: string,
  policyName: string | null,
  seed: string,
  replayRoot: string,
): Promise<ReplayEpisodeResult> => {
  const trajectory = (
    await readTrajectory(
      join(dataRoot, "episodes", sourceEpisodeId, "trajectory.jsonl"),
    )
  ).sort((a, b) => a.sequence - b.sequence);
  const first = trajectory[0];
  const last = trajectory.at(-1);
  if (first?.step !== "create_episode") {
    throw new Error(
      `${sourceEpisodeId}: trajectory does not start with create_episode`,
    );
  }
  if (last?.step !== "end_episode") {
    throw new Error(
      `${sourceEpisodeId}: trajectory does not end with end_episode`,
    );
  }
  if (first.engine.commit !== BASKETBALL_GM_ENGINE_METADATA.commit) {
    throw new Error(
      `${sourceEpisodeId}: recorded engine commit ${String(first.engine.commit)} does not match the pinned engine`,
    );
  }
  if (first.normalizedAction["initialSnapshotHash"] !== undefined) {
    throw new Error(
      `${sourceEpisodeId}: initial-snapshot replay is not supported without an action-linked snapshot artifact`,
    );
  }

  const episodes = new EpisodeManager(
    () => new BasketballGmEngine(),
    replayRoot,
  );
  const domain = new DomainService(
    episodes,
    createFileSnapshotStore(replayRoot),
  );
  let replayEpisodeId: string | undefined;
  let acceptedMutations = 0;
  let rollbackRecords = 0;
  const checkpointIds = new Map<string, string>();

  try {
    const created = await domain.createEpisode(first.args);
    replayEpisodeId = created.episodeId;
    if (created.stateHash !== first.postStateHash) {
      throw new ReplayMismatchError(
        sourceEpisodeId,
        first.sequence,
        first.step,
        `expected initial state hash ${first.postStateHash}, got ${created.stateHash}`,
      );
    }

    for (const record of trajectory.slice(1, -1)) {
      if (record.preStateHash === null) {
        throw new ReplayMismatchError(
          sourceEpisodeId,
          record.sequence,
          record.step,
          "non-create record has a null preStateHash",
        );
      }
      await assertHash(domain, replayEpisodeId, record, record.preStateHash);

      if (record.step === "checkpoint") {
        await applyNormalizedAction(
          domain,
          replayEpisodeId,
          record,
          checkpointIds,
        );
      } else if (record.step === "rollback") {
        rollbackRecords += 1;
        let failed = false;
        let actualCode: string | undefined;
        try {
          await applyNormalizedAction(
            domain,
            replayEpisodeId,
            record,
            checkpointIds,
          );
        } catch (error) {
          failed = true;
          actualCode = errorCode(error);
        }
        if (!failed) {
          throw new ReplayMismatchError(
            sourceEpisodeId,
            record.sequence,
            record.step,
            "recorded rejected action unexpectedly succeeded during replay",
          );
        }
        const expectedCode = record.rollback?.outcomeCode;
        if (expectedCode !== undefined && actualCode !== expectedCode) {
          throw new ReplayMismatchError(
            sourceEpisodeId,
            record.sequence,
            record.step,
            `recorded rejection code ${expectedCode}, replay produced ${actualCode ?? "unknown"}`,
          );
        }
        if (record.rollback?.restoredStateHash !== record.postStateHash) {
          throw new ReplayMismatchError(
            sourceEpisodeId,
            record.sequence,
            record.step,
            "recorded rollback restoredStateHash does not match postStateHash",
          );
        }
      } else if (record.step === "mutation") {
        await applyNormalizedAction(
          domain,
          replayEpisodeId,
          record,
          checkpointIds,
        );
        acceptedMutations += 1;
      } else {
        throw new ReplayMismatchError(
          sourceEpisodeId,
          record.sequence,
          record.step,
          "unexpected trajectory step before end_episode",
        );
      }

      await assertHash(domain, replayEpisodeId, record, record.postStateHash);
    }

    const ended = await domain.endEpisode(replayEpisodeId, {
      exportFinalSnapshot:
        last.args["exportFinalSnapshot"] === undefined
          ? true
          : Boolean(last.args["exportFinalSnapshot"]),
    });
    if (ended.finalState.stateHash !== last.postStateHash) {
      throw new ReplayMismatchError(
        sourceEpisodeId,
        last.sequence,
        last.step,
        `expected final state hash ${last.postStateHash}, got ${ended.finalState.stateHash}`,
      );
    }

    return {
      sourceEpisodeId,
      replayEpisodeId,
      policyName,
      seed,
      trajectoryRecords: trajectory.length,
      acceptedMutations,
      rollbackRecords,
      status: "verified",
    };
  } finally {
    await domain.closeAll();
  }
};

const sha256File = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const commandOutput = (command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
};

const sourceFileManifest = async (
  dataRoot: string,
  reportPath: string,
  episodes: string[],
): Promise<ReplayManifest["provenance"]["sourceFiles"]> => {
  const paths = [
    reportPath,
    resolve(root, "pnpm-lock.yaml"),
    resolve(root, "package.json"),
    resolve(root, "bbgm-engine.lock.json"),
    resolve(root, "scenarios/long-horizon-asset-preservation.json"),
    resolve(root, "scenarios/long-horizon-asset-preservation-dev.json"),
    resolve(root, "scenarios/long-horizon-asset-preservation-heldout.json"),
    resolve(root, "src/research/evaluate.ts"),
    resolve(root, "src/research/metrics.ts"),
    resolve(root, "src/research/objectives.ts"),
    resolve(root, "src/domain/schemas.ts"),
    resolve(root, "experiments/open-model/model-manifest.json"),
    resolve(root, "experiments/open-model/tinker-compatible-adapter.mts"),
    resolve(root, "experiments/external-policy/prompts/system-prompt-v2.md"),
  ];
  for (const episodeId of episodes) {
    for (const name of [
      "metadata.json",
      "trajectory.jsonl",
      "attempts.jsonl",
    ]) {
      paths.push(join(dataRoot, "episodes", episodeId, name));
    }
  }
  const uniquePaths = [...new Set(paths)];
  return Promise.all(
    uniquePaths.map(async (path) => ({
      path: relative(root, path),
      bytes: (await stat(path)).size,
      sha256: await sha256File(path),
    })),
  );
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "data-root": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    usage();
    return;
  }
  if (!values.report || !values["data-root"]) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (process.env["BBGM_SOURCE_DIR"] === undefined) {
    throw new Error("BBGM_SOURCE_DIR must point to the pinned engine checkout");
  }

  const reportPath = resolve(root, values.report);
  const dataRoot = resolve(root, values["data-root"]);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as ReportShape;
  const reportResults = report.results ?? [];
  if (reportResults.length === 0) {
    throw new Error("report contains no results");
  }
  const replayRoot = await mkdtemp(join(tmpdir(), "bbgm-grant-replay-"));
  const replayResults: ReplayEpisodeResult[] = [];
  try {
    for (const result of reportResults) {
      const sourceEpisodeId = asString(result.episodeId, "result.episodeId");
      const seed = asString(result.seed, "result.seed");
      replayResults.push(
        await replayEpisode(
          dataRoot,
          sourceEpisodeId,
          typeof result.policyName === "string" ? result.policyName : null,
          seed,
          replayRoot,
        ),
      );
      console.error(
        `grant-replay: verified ${sourceEpisodeId} (${replayResults.at(-1)?.rollbackRecords ?? 0} rollback record(s))`,
      );
    }
  } finally {
    await rm(replayRoot, { recursive: true, force: true });
  }

  const gitCommit = commandOutput("git", ["rev-parse", "HEAD"]);
  const gitStatus = commandOutput("git", ["status", "--porcelain"]);
  const pnpmVersion = commandOutput("pnpm", ["--version"]);
  const sourceFiles = await sourceFileManifest(
    dataRoot,
    reportPath,
    replayResults.map((result) => result.sourceEpisodeId),
  );
  const manifest: ReplayManifest = {
    schemaVersion: "grant-replay.v1",
    generatedAt: new Date().toISOString(),
    command: process.argv.join(" "),
    sourceReport: relative(root, reportPath),
    sourceDataRoot: relative(root, dataRoot),
    provenance: {
      gitCommit,
      workingTreeClean: gitStatus.length === 0,
      nodeVersion: process.version,
      pnpmVersion,
      lockfileSha256:
        sourceFiles.find((file) => file.path === "pnpm-lock.yaml")?.sha256 ??
        "unavailable",
      engine: BASKETBALL_GM_ENGINE_METADATA,
      sourceFiles,
    },
    episodes: replayResults,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (values.out) {
    const outPath = resolve(root, values.out);
    await writeFile(outPath, serialized, "utf8");
    console.error(`grant-replay: manifest written to ${outPath}`);
  } else {
    process.stdout.write(serialized);
  }
  console.error(
    `grant-replay: verified ${replayResults.length} episode(s) with ${replayResults.reduce((sum, result) => sum + result.rollbackRecords, 0)} rollback record(s)`,
  );
};

try {
  await main();
} catch (error: unknown) {
  if (error instanceof ReplayMismatchError) {
    console.error(`grant-replay: FAILED: ${error.message}`);
  } else {
    console.error(
      `grant-replay: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}
