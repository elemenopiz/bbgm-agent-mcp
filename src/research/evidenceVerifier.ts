import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AttemptRecord } from "../persistence/attemptLog.js";
import type { TrajectoryRecord } from "../persistence/trajectoryLog.js";

type JsonRecord = Record<string, unknown>;

export type EvidenceVerificationIssue = {
  path: string;
  message: string;
};

export type EvidenceVerificationResult = {
  reportPath: string;
  dataRoot: string;
  checkedResults: number;
  checkedEpisodes: number;
  rollbackNodes: number;
};

export class EvidenceVerificationError extends Error {
  readonly code = "EVIDENCE_VERIFICATION_FAILED" as const;
  readonly issues: EvidenceVerificationIssue[];

  constructor(issues: EvidenceVerificationIssue[]) {
    super(
      `Evidence verification failed with ${issues.length} issue(s): ${issues
        .slice(0, 5)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "EvidenceVerificationError";
    this.issues = issues;
  }
}

export type VerifyGrantArtifactOptions = {
  reportPath: string;
  dataRoot: string;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (
  value: unknown,
  path: string,
  issues: EvidenceVerificationIssue[],
): JsonRecord | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: "expected an object" });
    return undefined;
  }
  return value;
};

const asString = (
  value: unknown,
  path: string,
  issues: EvidenceVerificationIssue[],
): string | undefined => {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "expected a non-empty string" });
    return undefined;
  }
  return value;
};

const asFiniteNumber = (
  value: unknown,
  path: string,
  issues: EvidenceVerificationIssue[],
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "expected a finite number" });
    return undefined;
  }
  return value;
};

const asNonNegativeInteger = (
  value: unknown,
  path: string,
  issues: EvidenceVerificationIssue[],
): number | undefined => {
  const parsed = asFiniteNumber(value, path, issues);
  if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0)) {
    issues.push({ path, message: "expected a non-negative integer" });
    return undefined;
  }
  return parsed;
};

const asStringArray = (
  value: unknown,
  path: string,
  issues: EvidenceVerificationIssue[],
): string[] | undefined => {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "expected an array" });
    return undefined;
  }
  const values = value.map((item, index) =>
    asString(item, `${path}[${index}]`, issues),
  );
  const defined = values.filter(
    (value): value is string => value !== undefined,
  );
  if (new Set(defined).size !== defined.length) {
    issues.push({ path, message: "must not contain duplicate values" });
  }
  return defined;
};

const readJson = async (
  path: string,
  issues: EvidenceVerificationIssue[],
): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    issues.push({
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

const readJsonl = async <T>(
  path: string,
  issues: EvidenceVerificationIssue[],
): Promise<T[]> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    issues.push({
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  if (raw.length > 0 && !raw.endsWith("\n")) {
    issues.push({ path, message: "JSONL file has an unterminated final line" });
  }
  const records: T[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      issues.push({ path: `${path}:${index + 1}`, message: "invalid JSON" });
    }
  }
  return records;
};

const approximatelyEqual = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const validateSequence = (
  records: unknown[],
  path: string,
  episodeId: string,
  issues: EvidenceVerificationIssue[],
): void => {
  records.forEach((value, index) => {
    const record = asRecord(value, `${path}[${index}]`, issues);
    if (!record) return;
    if (record["episodeId"] !== episodeId) {
      issues.push({
        path: `${path}[${index}].episodeId`,
        message: `expected ${episodeId}`,
      });
    }
    const sequence = asNonNegativeInteger(
      record["sequence"],
      `${path}[${index}].sequence`,
      issues,
    );
    if (sequence !== undefined && sequence !== index) {
      issues.push({
        path: `${path}[${index}].sequence`,
        message: `expected contiguous sequence ${index}`,
      });
    }
  });
};

const validateTrajectory = (
  records: TrajectoryRecord[],
  path: string,
  episodeId: string,
  issues: EvidenceVerificationIssue[],
): { acceptedMutations: number; rollbackNodes: number } => {
  validateSequence(records, path, episodeId, issues);
  let acceptedMutations = 0;
  let rollbackNodes = 0;
  let previousPostHash: string | undefined;
  let previousRevision: number | undefined;

  records.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    if (!isRecord(record)) return;
    const step = record.step;
    if (
      step !== "create_episode" &&
      step !== "checkpoint" &&
      step !== "mutation" &&
      step !== "rollback" &&
      step !== "end_episode"
    ) {
      issues.push({
        path: `${recordPath}.step`,
        message: "unsupported trajectory step",
      });
      return;
    }
    const preStateHash = record.preStateHash;
    const postStateHash = record.postStateHash;
    if (
      (preStateHash !== null &&
        (typeof preStateHash !== "string" || preStateHash.length !== 64)) ||
      typeof postStateHash !== "string" ||
      postStateHash.length !== 64
    ) {
      issues.push({
        path: recordPath,
        message: "state hashes must be null or 64-character strings",
      });
    }
    const revision = asNonNegativeInteger(
      record.revision,
      `${recordPath}.revision`,
      issues,
    );

    if (index === 0) {
      if (step !== "create_episode" || preStateHash !== null) {
        issues.push({
          path: recordPath,
          message:
            "first trajectory record must be create_episode with null preStateHash",
        });
      }
    } else if (
      previousPostHash !== undefined &&
      preStateHash !== previousPostHash
    ) {
      issues.push({
        path: `${recordPath}.preStateHash`,
        message: "does not match the preceding postStateHash",
      });
    }

    if (step === "create_episode") {
      if (revision !== 0) {
        issues.push({
          path: `${recordPath}.revision`,
          message: "create revision must be 0",
        });
      }
    } else if (step === "checkpoint") {
      if (preStateHash !== postStateHash || revision !== previousRevision) {
        issues.push({
          path: recordPath,
          message:
            "checkpoint must preserve the current state hash and revision",
        });
      }
      const action = asRecord(
        record.normalizedAction,
        `${recordPath}.normalizedAction`,
        issues,
      );
      if (action?.["type"] !== "create_checkpoint") {
        issues.push({
          path: `${recordPath}.normalizedAction.type`,
          message: "checkpoint must record create_checkpoint",
        });
      }
      asString(
        action?.["checkpointId"],
        `${recordPath}.normalizedAction.checkpointId`,
        issues,
      );
    } else if (step === "mutation") {
      acceptedMutations += 1;
      if (
        revision !== undefined &&
        previousRevision !== undefined &&
        revision !== previousRevision + 1
      ) {
        issues.push({
          path: `${recordPath}.revision`,
          message: "accepted mutation must advance revision by exactly one",
        });
      }
    } else if (step === "rollback") {
      rollbackNodes += 1;
      if (revision !== previousRevision) {
        issues.push({
          path: `${recordPath}.revision`,
          message: "rollback must preserve the preceding revision",
        });
      }
      const rollback = asRecord(
        record.rollback,
        `${recordPath}.rollback`,
        issues,
      );
      if (rollback) {
        const restoredStateHash = rollback["restoredStateHash"];
        if (
          restoredStateHash !== postStateHash ||
          restoredStateHash !== preStateHash
        ) {
          issues.push({
            path: `${recordPath}.rollback.restoredStateHash`,
            message: "must equal both rollback preStateHash and postStateHash",
          });
        }
        asString(
          rollback["outcomeCode"],
          `${recordPath}.rollback.outcomeCode`,
          issues,
        );
        if (typeof rollback["rollbackRequired"] !== "boolean") {
          issues.push({
            path: `${recordPath}.rollback.rollbackRequired`,
            message: "expected a boolean",
          });
        }
      }
    } else if (step === "end_episode") {
      if (preStateHash !== postStateHash || revision !== previousRevision) {
        issues.push({
          path: recordPath,
          message:
            "end_episode must preserve the current state hash and revision",
        });
      }
    }

    if (typeof postStateHash === "string") previousPostHash = postStateHash;
    if (revision !== undefined) previousRevision = revision;
  });

  if (records.length === 0 || records.at(-1)?.step !== "end_episode") {
    issues.push({ path, message: "trajectory must end with end_episode" });
  }
  return { acceptedMutations, rollbackNodes };
};

const validateAttempts = (
  records: AttemptRecord[],
  path: string,
  episodeId: string,
  issues: EvidenceVerificationIssue[],
): {
  agentAttempts: AttemptRecord[];
  acceptedMutations: number;
  rejectedMutations: number;
} => {
  validateSequence(records, path, episodeId, issues);
  const agentAttempts = records.filter(
    (attempt) =>
      attempt.actor !== "evaluator" &&
      attempt.kind !== "lifecycle" &&
      attempt.operation !== "bbgm_get_state",
  );
  const mutationAttempts = agentAttempts.filter(
    (attempt) => attempt.kind === "mutation",
  );
  return {
    agentAttempts,
    acceptedMutations: mutationAttempts.filter(
      (attempt) => attempt.outcome === "accepted",
    ).length,
    rejectedMutations: mutationAttempts.filter(
      (attempt) => attempt.outcome === "rejected",
    ).length,
  };
};

const validateEpisode = async (
  result: JsonRecord,
  index: number,
  dataRoot: string,
  horizonSeasons: number | undefined,
  maxSteps: number | undefined,
  issues: EvidenceVerificationIssue[],
): Promise<number> => {
  const resultPath = `report.results[${index}]`;
  const episodeId = asString(
    result["episodeId"],
    `${resultPath}.episodeId`,
    issues,
  );
  const scenarioId = asString(
    result["scenarioId"],
    `${resultPath}.scenarioId`,
    issues,
  );
  const seed = asString(result["seed"], `${resultPath}.seed`, issues);
  if (!episodeId || !scenarioId || !seed) return 0;

  const episodeRoot = join(dataRoot, "episodes", episodeId);
  const metadata = asRecord(
    await readJson(join(episodeRoot, "metadata.json"), issues),
    `${episodeRoot}/metadata.json`,
    issues,
  );
  if (metadata) {
    for (const [key, expected] of [
      ["episodeId", episodeId],
      ["scenarioId", scenarioId],
      ["seed", seed],
    ] as const) {
      if (metadata[key] !== expected) {
        issues.push({
          path: `${episodeRoot}/metadata.json.${key}`,
          message: `does not match report value ${expected}`,
        });
      }
    }
    if (metadata["status"] !== "ended") {
      issues.push({
        path: `${episodeRoot}/metadata.json.status`,
        message:
          "grant report episodes must be ended, not active or quarantined",
      });
    }
  }

  const trajectory = await readJsonl<TrajectoryRecord>(
    join(episodeRoot, "trajectory.jsonl"),
    issues,
  );
  const attempts = await readJsonl<AttemptRecord>(
    join(episodeRoot, "attempts.jsonl"),
    issues,
  );
  const trajectoryStats = validateTrajectory(
    trajectory,
    `${episodeRoot}/trajectory.jsonl`,
    episodeId,
    issues,
  );
  const attemptStats = validateAttempts(
    attempts,
    `${episodeRoot}/attempts.jsonl`,
    episodeId,
    issues,
  );

  if (metadata) {
    const expectedTrajectorySequence = trajectory.length;
    const expectedAttemptSequence = attempts.length;
    if (metadata["trajectorySequence"] !== expectedTrajectorySequence) {
      issues.push({
        path: `${episodeRoot}/metadata.json.trajectorySequence`,
        message: `expected ${expectedTrajectorySequence}`,
      });
    }
    if (metadata["attemptSequence"] !== expectedAttemptSequence) {
      issues.push({
        path: `${episodeRoot}/metadata.json.attemptSequence`,
        message: `expected ${expectedAttemptSequence}`,
      });
    }
    const finalTrajectory = trajectory.at(-1);
    if (
      finalTrajectory &&
      typeof metadata["stateHash"] === "string" &&
      metadata["stateHash"] !== finalTrajectory.postStateHash
    ) {
      issues.push({
        path: `${episodeRoot}/metadata.json.stateHash`,
        message: "does not match the final trajectory postStateHash",
      });
    }
  }

  const summary = asRecord(
    result["trajectorySummary"],
    `${resultPath}.trajectorySummary`,
    issues,
  );
  const stepsTaken = asNonNegativeInteger(
    result["stepsTaken"],
    `${resultPath}.stepsTaken`,
    issues,
  );
  const policyTelemetry =
    result["policyTelemetry"] === undefined
      ? undefined
      : asRecord(
          result["policyTelemetry"],
          `${resultPath}.policyTelemetry`,
          issues,
        );
  const modelCallCount = policyTelemetry
    ? asNonNegativeInteger(
        policyTelemetry["modelCallCount"],
        `${resultPath}.policyTelemetry.modelCallCount`,
        issues,
      )
    : 0;
  const parseErrorCount = policyTelemetry
    ? asNonNegativeInteger(
        policyTelemetry["parseErrorCount"],
        `${resultPath}.policyTelemetry.parseErrorCount`,
        issues,
      )
    : 0;
  if (
    policyTelemetry &&
    modelCallCount !== undefined &&
    parseErrorCount !== undefined &&
    parseErrorCount > modelCallCount
  ) {
    issues.push({
      path: `${resultPath}.policyTelemetry.parseErrorCount`,
      message: "cannot exceed modelCallCount",
    });
  }
  if (summary) {
    const expectedCounters: [string, number][] = [
      ["agentAttemptCount", attemptStats.agentAttempts.length],
      [
        "rejectedAttemptCount",
        attemptStats.agentAttempts.filter(
          (attempt) => attempt.outcome === "rejected",
        ).length,
      ],
      [
        "staleActionCount",
        attemptStats.agentAttempts.filter(
          (attempt) => attempt.outcomeCode === "REVISION_CONFLICT",
        ).length,
      ],
      [
        "idempotentReplayCount",
        attemptStats.agentAttempts.filter(
          (attempt) => attempt.outcome === "idempotent_replay",
        ).length,
      ],
      ["mutationSteps", trajectoryStats.acceptedMutations],
      ["rollbackCount", trajectoryStats.rollbackNodes],
      [
        "totalSteps",
        trajectory.filter((record) => record.step !== "rollback").length,
      ],
    ];
    for (const [key, expected] of expectedCounters) {
      const actual = asNonNegativeInteger(
        summary[key],
        `${resultPath}.trajectorySummary.${key}`,
        issues,
      );
      if (actual !== undefined && actual !== expected) {
        issues.push({
          path: `${resultPath}.trajectorySummary.${key}`,
          message: `expected ${expected}, found ${actual}`,
        });
      }
    }
    const agentAttemptCount = asNonNegativeInteger(
      summary["agentAttemptCount"],
      `${resultPath}.trajectorySummary.agentAttemptCount`,
      issues,
    );
    const rejectedAttemptCount = asNonNegativeInteger(
      summary["rejectedAttemptCount"],
      `${resultPath}.trajectorySummary.rejectedAttemptCount`,
      issues,
    );
    const actionDenominator =
      agentAttemptCount === undefined || parseErrorCount === undefined
        ? undefined
        : agentAttemptCount + parseErrorCount;
    const expectedInvalidRate =
      agentAttemptCount === undefined ||
      rejectedAttemptCount === undefined ||
      parseErrorCount === undefined ||
      actionDenominator === undefined ||
      actionDenominator === 0
        ? undefined
        : (rejectedAttemptCount + parseErrorCount) / actionDenominator;
    const metrics = asRecord(
      result["metricComponents"],
      `${resultPath}.metricComponents`,
      issues,
    );
    if (metrics && expectedInvalidRate !== undefined) {
      const invalidRate = asFiniteNumber(
        metrics["invalid_action_rate"],
        `${resultPath}.metricComponents.invalid_action_rate`,
        issues,
      );
      if (
        invalidRate !== undefined &&
        !approximatelyEqual(invalidRate, expectedInvalidRate)
      ) {
        issues.push({
          path: `${resultPath}.metricComponents.invalid_action_rate`,
          message: `expected ${expectedInvalidRate}`,
        });
      }
      if (maxSteps !== undefined && stepsTaken !== undefined) {
        const stepsUsedRatio = asFiniteNumber(
          metrics["steps_used_ratio"],
          `${resultPath}.metricComponents.steps_used_ratio`,
          issues,
        );
        if (
          stepsUsedRatio !== undefined &&
          !approximatelyEqual(stepsUsedRatio, stepsTaken / maxSteps)
        ) {
          issues.push({
            path: `${resultPath}.metricComponents.steps_used_ratio`,
            message: `expected ${stepsTaken / maxSteps}`,
          });
        }
      }
    }
  }

  const completionStatus = asString(
    result["completionStatus"],
    `${resultPath}.completionStatus`,
    issues,
  );
  const terminalMetrics = asRecord(
    result["terminalMetrics"],
    `${resultPath}.terminalMetrics`,
    issues,
  );
  const seasonsCompleted = terminalMetrics
    ? asNonNegativeInteger(
        terminalMetrics["seasonsCompleted"],
        `${resultPath}.terminalMetrics.seasonsCompleted`,
        issues,
      )
    : undefined;
  if (
    completionStatus === "completed" &&
    horizonSeasons !== undefined &&
    seasonsCompleted !== undefined &&
    seasonsCompleted < horizonSeasons
  ) {
    issues.push({
      path: `${resultPath}.completionStatus`,
      message: "completed result did not reach the declared season horizon",
    });
  }
  if (
    completionStatus === "stalled" &&
    horizonSeasons !== undefined &&
    seasonsCompleted !== undefined &&
    seasonsCompleted >= horizonSeasons
  ) {
    issues.push({
      path: `${resultPath}.completionStatus`,
      message: "stalled result reached the declared season horizon",
    });
  }
  if (
    completionStatus === "budget_exhausted" &&
    maxSteps !== undefined &&
    stepsTaken !== undefined &&
    stepsTaken < maxSteps
  ) {
    issues.push({
      path: `${resultPath}.stepsTaken`,
      message:
        "budget_exhausted result used fewer than maxSteps evaluator turns",
    });
  }
  if (terminalMetrics && result["episodeId"] !== terminalMetrics["episodeId"]) {
    issues.push({
      path: `${resultPath}.terminalMetrics.episodeId`,
      message: "does not match result episodeId",
    });
  }
  const metrics = asRecord(
    result["metricComponents"],
    `${resultPath}.metricComponents`,
    issues,
  );
  if (metrics && terminalMetrics) {
    for (const [metric, terminalKey] of [
      ["seasons_completed", "seasonsCompleted"],
      ["hard_constraint_violations", "hardConstraintViolations"],
    ] as const) {
      const metricValue = asFiniteNumber(
        metrics[metric],
        `${resultPath}.metricComponents.${metric}`,
        issues,
      );
      const terminalValue = asFiniteNumber(
        terminalMetrics[terminalKey],
        `${resultPath}.terminalMetrics.${terminalKey}`,
        issues,
      );
      if (
        metricValue !== undefined &&
        terminalValue !== undefined &&
        !approximatelyEqual(metricValue, terminalValue)
      ) {
        issues.push({
          path: `${resultPath}.metricComponents.${metric}`,
          message: `does not match terminalMetrics.${terminalKey}`,
        });
      }
    }
  }

  if (attemptStats.acceptedMutations !== trajectoryStats.acceptedMutations) {
    issues.push({
      path: resultPath,
      message: `accepted mutation attempt count ${attemptStats.acceptedMutations} does not match trajectory mutation count ${trajectoryStats.acceptedMutations}`,
    });
  }
  if (trajectoryStats.rollbackNodes > attemptStats.rejectedMutations) {
    issues.push({
      path: resultPath,
      message: `rollback node count ${trajectoryStats.rollbackNodes} exceeds rejected mutation count ${attemptStats.rejectedMutations}`,
    });
  }

  return trajectoryStats.rollbackNodes;
};

const validateReport = async (
  reportPath: string,
  dataRoot: string,
  issues: EvidenceVerificationIssue[],
): Promise<number> => {
  const report = asRecord(
    await readJson(reportPath, issues),
    reportPath,
    issues,
  );
  if (!report) return 0;
  if (report["reportVersion"] !== 1) {
    issues.push({
      path: `${reportPath}.reportVersion`,
      message: "expected report version 1",
    });
  }
  const scenario = asRecord(
    report["scenario"],
    `${reportPath}.scenario`,
    issues,
  );
  const scenarioId = scenario
    ? asString(
        scenario["scenarioId"],
        `${reportPath}.scenario.scenarioId`,
        issues,
      )
    : undefined;
  const seeds = scenario
    ? asStringArray(
        scenario["seedSet"],
        `${reportPath}.scenario.seedSet`,
        issues,
      )
    : undefined;
  const horizonSeasons = scenario
    ? asNonNegativeInteger(
        scenario["horizonSeasons"],
        `${reportPath}.scenario.horizonSeasons`,
        issues,
      )
    : undefined;
  const maxSteps = scenario
    ? asNonNegativeInteger(
        scenario["maxSteps"],
        `${reportPath}.scenario.maxSteps`,
        issues,
      )
    : undefined;
  const resultsInput = Array.isArray(report["results"])
    ? report["results"]
    : undefined;
  if (!resultsInput) {
    issues.push({
      path: `${reportPath}.results`,
      message: "expected an array",
    });
    return 0;
  }
  const results = resultsInput
    .map((value, index) => asRecord(value, `report.results[${index}]`, issues))
    .filter((value): value is JsonRecord => value !== undefined);
  const policyNames = [
    ...new Set(results.map((result) => result["policyName"])),
  ];
  if (!policyNames.includes("no_op") || !policyNames.includes("heuristic")) {
    issues.push({
      path: `${reportPath}.results`,
      message: "must include no_op and heuristic baselines",
    });
  }
  if (seeds) {
    const expected = new Set(
      policyNames.flatMap((policy) =>
        seeds.map((seed) => `${String(policy)}:${seed}`),
      ),
    );
    const actual = results.map(
      (result) => `${String(result["policyName"])}:${String(result["seed"])}`,
    );
    if (
      actual.length !== expected.size ||
      new Set(actual).size !== actual.length ||
      actual.some((key) => !expected.has(key))
    ) {
      issues.push({
        path: `${reportPath}.results`,
        message:
          "does not contain exactly one result for every declared policy/seed pair",
      });
    }
    for (const [index, result] of results.entries()) {
      if (scenarioId && result["scenarioId"] !== scenarioId) {
        issues.push({
          path: `report.results[${index}].scenarioId`,
          message: `expected ${scenarioId}`,
        });
      }
      const seed = result["seed"];
      if (typeof seed !== "string" || !seeds.includes(seed)) {
        issues.push({
          path: `report.results[${index}].seed`,
          message: "is not declared in scenario.seedSet",
        });
      }
    }
  }
  const provenance = asRecord(
    report["provenance"],
    `${reportPath}.provenance`,
    issues,
  );
  if (provenance && seeds) {
    for (const key of ["declaredSeeds", "evaluatedSeeds"] as const) {
      const provenanceSeeds = asStringArray(
        provenance[key],
        `${reportPath}.provenance.${key}`,
        issues,
      );
      if (
        provenanceSeeds &&
        JSON.stringify([...provenanceSeeds].sort()) !==
          JSON.stringify([...seeds].sort())
      ) {
        issues.push({
          path: `${reportPath}.provenance.${key}`,
          message: "does not match scenario.seedSet",
        });
      }
    }
  }
  const repository =
    provenance?.["repository"] !== undefined
      ? asRecord(
          provenance["repository"],
          `${reportPath}.provenance.repository`,
          issues,
        )
      : undefined;
  if (repository) {
    asString(
      repository["gitCommit"],
      `${reportPath}.provenance.repository.gitCommit`,
      issues,
    );
    if (typeof repository["workingTreeClean"] !== "boolean") {
      issues.push({
        path: `${reportPath}.provenance.repository.workingTreeClean`,
        message: "expected a boolean",
      });
    }
    for (const key of [
      "gitStatusSha256",
      "gitDiffSha256",
      "lockfileSha256",
    ] as const) {
      asString(
        repository[key],
        `${reportPath}.provenance.repository.${key}`,
        issues,
      );
    }
  }
  const aggregatesInput = Array.isArray(report["aggregates"])
    ? report["aggregates"]
    : undefined;
  if (!aggregatesInput) {
    issues.push({
      path: `${reportPath}.aggregates`,
      message: "expected an array",
    });
  } else {
    const aggregates = aggregatesInput
      .map((value, index) =>
        asRecord(value, `${reportPath}.aggregates[${index}]`, issues),
      )
      .filter((value): value is JsonRecord => value !== undefined);
    for (const policy of policyNames) {
      const policyName = String(policy);
      const policyResults = results.filter(
        (result) => result["policyName"] === policy,
      );
      const aggregate = aggregates.find(
        (candidate) => candidate["policyName"] === policyName,
      );
      if (!aggregate) {
        issues.push({
          path: `${reportPath}.aggregates`,
          message: `missing aggregate for policy ${policyName}`,
        });
        continue;
      }
      const runCount = asNonNegativeInteger(
        aggregate["runCount"],
        `${reportPath}.aggregates.${policyName}.runCount`,
        issues,
      );
      if (runCount !== undefined && runCount !== policyResults.length) {
        issues.push({
          path: `${reportPath}.aggregates.${policyName}.runCount`,
          message: `expected ${policyResults.length}`,
        });
      }
      const aggregateMetrics = asRecord(
        aggregate["metricComponents"],
        `${reportPath}.aggregates.${policyName}.metricComponents`,
        issues,
      );
      const metricSummaries = asRecord(
        aggregate["metricSummaries"],
        `${reportPath}.aggregates.${policyName}.metricSummaries`,
        issues,
      );
      if (!aggregateMetrics) continue;
      const metricNames = new Set<string>();
      for (const result of policyResults) {
        const metrics = isRecord(result["metricComponents"])
          ? result["metricComponents"]
          : undefined;
        if (metrics) {
          for (const name of Object.keys(metrics)) metricNames.add(name);
        }
      }
      for (const metric of metricNames) {
        const values = policyResults
          .map((result) =>
            isRecord(result["metricComponents"])
              ? result["metricComponents"][metric]
              : undefined,
          )
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value),
          );
        if (values.length !== policyResults.length || values.length === 0) {
          issues.push({
            path: `${reportPath}.aggregates.${policyName}.${metric}`,
            message: "cannot recompute metric from every result",
          });
          continue;
        }
        const mean =
          values.reduce((sum, value) => sum + value, 0) / values.length;
        const aggregateMean = asFiniteNumber(
          aggregateMetrics[metric],
          `${reportPath}.aggregates.${policyName}.metricComponents.${metric}`,
          issues,
        );
        if (
          aggregateMean !== undefined &&
          !approximatelyEqual(mean, aggregateMean)
        ) {
          issues.push({
            path: `${reportPath}.aggregates.${policyName}.metricComponents.${metric}`,
            message: `expected recomputed mean ${mean}`,
          });
        }
        if (metricSummaries && isRecord(metricSummaries[metric])) {
          const summary = metricSummaries[metric];
          const count = asNonNegativeInteger(
            summary["count"],
            `${reportPath}.aggregates.${policyName}.metricSummaries.${metric}.count`,
            issues,
          );
          if (count !== undefined && count !== values.length) {
            issues.push({
              path: `${reportPath}.aggregates.${policyName}.metricSummaries.${metric}.count`,
              message: `expected ${values.length}`,
            });
          }
          const summaryMean = asFiniteNumber(
            summary["mean"],
            `${reportPath}.aggregates.${policyName}.metricSummaries.${metric}.mean`,
            issues,
          );
          if (
            summaryMean !== undefined &&
            !approximatelyEqual(mean, summaryMean)
          ) {
            issues.push({
              path: `${reportPath}.aggregates.${policyName}.metricSummaries.${metric}.mean`,
              message: `expected recomputed mean ${mean}`,
            });
          }
        }
      }
    }
  }
  const comparison = asRecord(
    report["comparison"],
    `${reportPath}.comparison`,
    issues,
  );
  if (comparison && Array.isArray(comparison["rankedEpisodeIds"])) {
    const ranked = comparison["rankedEpisodeIds"].filter(
      (value): value is string => typeof value === "string",
    );
    const aggregateRecords = Array.isArray(report["aggregates"])
      ? report["aggregates"].filter(isRecord)
      : [];
    const rates = aggregateRecords
      .map((aggregate) => ({
        id: aggregate["policyName"],
        rate: aggregate["completionRate"],
      }))
      .filter(
        (value): value is { id: string; rate: number } =>
          typeof value.id === "string" &&
          typeof value.rate === "number" &&
          Number.isFinite(value.rate),
      );
    if (rates.length > 0) {
      const expected = [...rates]
        .sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id))
        .map((value) => value.id);
      if (JSON.stringify(ranked) !== JSON.stringify(expected)) {
        issues.push({
          path: `${reportPath}.comparison.rankedEpisodeIds`,
          message: "does not rank aggregate policies by completionRate first",
        });
      }
    }
  }
  let rollbackNodes = 0;
  for (const [index, result] of results.entries()) {
    rollbackNodes += await validateEpisode(
      result,
      index,
      dataRoot,
      horizonSeasons,
      maxSteps,
      issues,
    );
  }
  return rollbackNodes;
};

export const verifyGrantArtifact = async (
  options: VerifyGrantArtifactOptions,
): Promise<EvidenceVerificationResult> => {
  const issues: EvidenceVerificationIssue[] = [];
  const rollbackNodes = await validateReport(
    options.reportPath,
    options.dataRoot,
    issues,
  );
  if (issues.length > 0) throw new EvidenceVerificationError(issues);
  const report = JSON.parse(
    await readFile(options.reportPath, "utf8"),
  ) as JsonRecord;
  const results = Array.isArray(report["results"]) ? report["results"] : [];
  return {
    reportPath: options.reportPath,
    dataRoot: options.dataRoot,
    checkedResults: results.length,
    checkedEpisodes: results.length,
    rollbackNodes,
  };
};
