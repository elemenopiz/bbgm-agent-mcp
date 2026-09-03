import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EvidenceVerificationError,
  verifyGrantArtifact,
} from "../../src/research/evidenceVerifier.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const writeFixture = async () => {
  const uniqueRoot = await mkdtemp(join(tmpdir(), "bbgm-evidence-test-"));
  tempRoots.push(uniqueRoot);

  const dataRoot = join(uniqueRoot, "data");
  const reportPath = join(uniqueRoot, "report.json");
  const episodeId = "episode-1";
  const episodeRoot = join(dataRoot, "episodes", episodeId);
  await mkdir(episodeRoot, { recursive: true });

  const trajectory = [
    {
      episodeId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      step: "create_episode",
      toolName: "bbgm_create_episode",
      args: {},
      preStateHash: null,
      postStateHash: hashA,
      revision: 0,
      normalizedAction: { type: "create_episode" },
      events: [],
      invariantResults: [],
      latencyMs: 0,
      engine: { name: "fake", version: "test" },
      wrapperVersion: "0.1.0",
    },
    {
      episodeId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      step: "rollback",
      toolName: "bbgm_release_player",
      args: {},
      preStateHash: hashA,
      postStateHash: hashA,
      revision: 0,
      normalizedAction: { type: "release_player", pid: 1 },
      events: [
        {
          type: "rollback",
          outcomeCode: "ENGINE_ERROR",
          rollbackRequired: true,
          restoredStateHash: hashA,
        },
      ],
      invariantResults: [],
      latencyMs: 1,
      engine: { name: "fake", version: "test" },
      wrapperVersion: "0.1.0",
      rollback: {
        outcomeCode: "ENGINE_ERROR",
        rollbackRequired: true,
        restoredStateHash: hashA,
      },
    },
    {
      episodeId,
      sequence: 2,
      timestamp: new Date().toISOString(),
      step: "mutation",
      toolName: "bbgm_advance",
      args: {},
      preStateHash: hashA,
      postStateHash: hashB,
      revision: 1,
      normalizedAction: { type: "advance", target: "next_game" },
      events: [],
      invariantResults: [],
      latencyMs: 1,
      engine: { name: "fake", version: "test" },
      wrapperVersion: "0.1.0",
    },
    {
      episodeId,
      sequence: 3,
      timestamp: new Date().toISOString(),
      step: "end_episode",
      toolName: "bbgm_end_episode",
      args: {},
      preStateHash: hashB,
      postStateHash: hashB,
      revision: 1,
      normalizedAction: { type: "end_episode" },
      events: [],
      invariantResults: [],
      latencyMs: 0,
      engine: { name: "fake", version: "test" },
      wrapperVersion: "0.1.0",
    },
  ];
  const attempts = [
    {
      episodeId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      operation: "bbgm_create_episode",
      kind: "lifecycle",
      outcome: "accepted",
    },
    {
      episodeId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      operation: "bbgm_release_player",
      kind: "mutation",
      outcome: "rejected",
      outcomeCode: "ENGINE_ERROR",
    },
    {
      episodeId,
      sequence: 2,
      timestamp: new Date().toISOString(),
      operation: "bbgm_advance",
      kind: "mutation",
      outcome: "accepted",
    },
    {
      episodeId,
      sequence: 3,
      timestamp: new Date().toISOString(),
      operation: "bbgm_end_episode",
      kind: "lifecycle",
      outcome: "accepted",
    },
  ];
  await writeFile(
    join(episodeRoot, "trajectory.jsonl"),
    `${trajectory.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await writeFile(
    join(episodeRoot, "attempts.jsonl"),
    `${attempts.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await writeFile(
    join(episodeRoot, "metadata.json"),
    JSON.stringify({
      schemaVersion: "1",
      episodeId,
      scenarioId: "scenario-1",
      seed: "seed-1",
      engine: { name: "fake", version: "test" },
      userTeamId: 0,
      startingSeason: 2026,
      constraints: { hard: [], soft: [] },
      scenarioPolicy: {
        allowedInformation: ["overview"],
        allowedActions: ["advance"],
        maxSteps: 4,
        horizonSeasons: 1,
      },
      revision: 1,
      status: "ended",
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      stateHash: hashB,
      trajectorySequence: 4,
      invariantViolationCount: 0,
      transactionEventCount: 0,
      stepCount: 2,
      attemptSequence: 4,
      checkpoints: [],
      idempotency: {},
    }),
  );

  const result = {
    scenarioId: "scenario-1",
    seed: "seed-1",
    policyName: "heuristic",
    episodeId,
    stepsTaken: 1,
    completionStatus: "completed",
    terminalMetrics: {
      episodeId,
      seasonsCompleted: 1,
      hardConstraintViolations: 0,
    },
    metricComponents: {
      seasons_completed: 1,
      hard_constraint_violations: 0,
      invalid_action_rate: 0.5,
      steps_used_ratio: 0.25,
    },
    trajectorySummary: {
      totalSteps: 3,
      mutationSteps: 1,
      rollbackCount: 1,
      toolCallCounts: {},
      invalidActionCount: 0,
      transactionCount: 0,
      averageLatencyMs: 0,
      agentAttemptCount: 2,
      rejectedAttemptCount: 1,
      staleActionCount: 0,
      idempotentReplayCount: 0,
    },
  };
  const aggregateFor = (policyName: string) => ({
    policyName,
    runCount: 1,
    metricComponents: result.metricComponents,
    metricSummaries: Object.fromEntries(
      Object.entries(result.metricComponents).map(([metric, value]) => [
        metric,
        {
          count: 1,
          mean: value,
          standardDeviation: 0,
          minimum: value,
          maximum: value,
        },
      ]),
    ),
  });
  await writeFile(
    reportPath,
    JSON.stringify({
      reportVersion: 1,
      scenario: {
        scenarioId: "scenario-1",
        seedSet: ["seed-1"],
        horizonSeasons: 1,
        maxSteps: 4,
      },
      reward: { mode: "lexicographic" },
      provenance: {
        declaredSeeds: ["seed-1"],
        evaluatedSeeds: ["seed-1"],
      },
      aggregates: [aggregateFor("heuristic"), aggregateFor("no_op")],
      comparison: {},
      results: [result, { ...result, policyName: "no_op", episodeId }],
    }),
  );
  return { reportPath, dataRoot, episodeRoot };
};

describe("verifyGrantArtifact", () => {
  test("accepts a complete report and linked rollback audit trail", async () => {
    const fixture = await writeFixture();
    const verified = await verifyGrantArtifact(fixture);
    expect(verified.checkedResults).toBe(2);
    expect(verified.checkedEpisodes).toBe(2);
    expect(verified.rollbackNodes).toBe(2);
  });

  test("rejects a tampered state chain", async () => {
    const fixture = await writeFixture();
    const path = join(fixture.episodeRoot, "trajectory.jsonl");
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    records[2] = { ...records[2], preStateHash: "c".repeat(64) };
    await writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    await expect(verifyGrantArtifact(fixture)).rejects.toSatisfy(
      (error: unknown) => {
        return (
          error instanceof EvidenceVerificationError &&
          error.issues.some((issue) =>
            issue.message.includes("preceding postStateHash"),
          )
        );
      },
    );
  });
});
