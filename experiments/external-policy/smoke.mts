import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DomainService } from "../../src/domain/DomainService.js";
import { createFileSnapshotStore } from "../../src/persistence/snapshots.js";
import { EpisodeManager } from "../../src/sessions/EpisodeManager.js";
import { DeterministicDemoEngine } from "./fakeEngine.mjs";
import { ExternalPolicyRunner, JsonlAuditSink } from "./runner.js";
import type { ModelCallback, StepRecord } from "./types.js";

const outputArgument = process.argv.find((argument) =>
  argument.startsWith("--out="),
);
const outputPath = resolve(
  outputArgument?.slice("--out=".length) ??
    "experiments/external-policy/artifacts/fake-run.jsonl",
);
const failureOutputPath = outputPath.replace(/\.jsonl$/u, ".failure.jsonl");

const fakeCallback: ModelCallback = (observation) => ({
  toolName: "bbgm_advance",
  arguments: {
    target: observation.phase === "preseason" ? "next_game" : "next_decision",
  },
});

const assertRecord = (record: StepRecord): void => {
  if (
    record.rawModelOutput === null ||
    record.parsedAction === null ||
    record.actionEnvelope === null ||
    record.toolResult?.status !== "ok" ||
    record.failure !== null ||
    record.idempotency.status !== "applied" ||
    record.revision.before === null ||
    record.revision.after !== record.revision.before + 1
  ) {
    throw new Error(
      `Invalid successful step record at sequence ${record.sequence}`,
    );
  }
};

const main = async (): Promise<void> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "bbgm-external-policy-"));
  await rm(outputPath, { force: true });
  await rm(failureOutputPath, { force: true });
  const domain = new DomainService(
    new EpisodeManager(() => new DeterministicDemoEngine(), dataRoot),
    createFileSnapshotStore(dataRoot),
  );

  try {
    const overview = await domain.createEpisode({
      scenarioId: "external-policy-protocol-smoke",
      seed: "deterministic-smoke-seed",
      userTeamId: 0,
      startingSeason: 2026,
    });
    const audit = new JsonlAuditSink(outputPath);
    const runner = new ExternalPolicyRunner(
      domain,
      overview.episodeId,
      fakeCallback,
      audit,
      "external-policy",
      {
        allowedInformation: ["overview"],
        allowedActions: ["advance"],
        maxSteps: 3,
      },
    );
    const records = await runner.run(3);
    records.forEach(assertRecord);

    const lines = (await readFile(outputPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (lines.length !== 3) {
      throw new Error(`Expected three audit records, found ${lines.length}`);
    }
    for (const line of lines) JSON.parse(line);

    let rejectedInvalidOutput = false;
    try {
      await new ExternalPolicyRunner(
        domain,
        overview.episodeId,
        () => [],
        new JsonlAuditSink(failureOutputPath),
        "external-policy-invalid",
        {
          allowedInformation: ["overview"],
          allowedActions: ["advance"],
          maxSteps: 1,
        },
      ).run(1);
    } catch {
      rejectedInvalidOutput = true;
    }
    if (!rejectedInvalidOutput) {
      throw new Error("Invalid model output was unexpectedly accepted");
    }
    const failureLines = (await readFile(failureOutputPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    const failureRecord = JSON.parse(failureLines[0] ?? "null") as StepRecord;
    if (
      failureLines.length !== 1 ||
      failureRecord.failure?.stage !== "parse" ||
      failureRecord.toolResult !== null ||
      failureRecord.idempotency.status !== "not_applied"
    ) {
      throw new Error("Invalid model output did not produce an audit failure");
    }

    console.log(
      JSON.stringify(
        {
          status: "ok",
          protocol: "DomainService direct contract",
          steps: records.length,
          firstRevision: records[0]?.revision.before,
          finalRevision: records.at(-1)?.revision.after,
          auditPath: outputPath,
          failureAuditPath: failureOutputPath,
          limitation:
            "This validates the callback/action/audit boundary with a deterministic fixture; it is not a learned-model or Tinker result.",
        },
        null,
        2,
      ),
    );
  } finally {
    await domain.closeAll();
    await rm(dataRoot, { recursive: true, force: true });
  }
};

await main();
