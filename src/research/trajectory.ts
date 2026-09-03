import { readFile } from "node:fs/promises";

export type { TrajectoryRecord } from "../persistence/trajectoryLog.js";
import type { TrajectoryRecord } from "../persistence/trajectoryLog.js";
import type { AttemptRecord } from "../persistence/attemptLog.js";

export const readTrajectory = async (
  path: string,
): Promise<TrajectoryRecord[]> => {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TrajectoryRecord);
};

export const readAttempts = async (path: string): Promise<AttemptRecord[]> => {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AttemptRecord);
};

export type TrajectorySummary = {
  totalSteps: number;
  mutationSteps: number;
  rollbackCount: number;
  toolCallCounts: Record<string, number>;
  invalidActionCount: number;
  transactionCount: number;
  averageLatencyMs: number;
  agentAttemptCount: number;
  rejectedAttemptCount: number;
  staleActionCount: number;
  idempotentReplayCount: number;
  checkpointCount: number;
};

/**
 * Rolls a trajectory into step-count style metrics. "Invalid" here means a
 * mutation step whose invariant results contained a hard failure at write
 * time -- since failed mutations are rolled back rather than appended (see
 * DomainService), an accepted trajectory never itself contains an invalid
 * step; this is retained for forward-compatibility with harnesses that log
 * rejected attempts separately and pass them in.
 */
export const summarizeTrajectory = (
  records: TrajectoryRecord[],
  attempts: AttemptRecord[] = [],
): TrajectorySummary => {
  const toolCallCounts: Record<string, number> = {};
  const behavioralRecords = records.filter(
    (record) => record.step !== "rollback",
  );
  let transactionCount = 0;
  let invalidActionCount = 0;
  let latencySum = 0;
  let mutationSteps = 0;
  let checkpointCount = 0;
  // Attempt logs are also used for evaluator observations and episode
  // lifecycle bookkeeping. Keep the actor field backward-compatible for old
  // records that omitted it, while classifying those non-action records by
  // their stable kind/operation fields.
  const agentAttempts = attempts.filter(
    (attempt) =>
      attempt.actor !== "evaluator" &&
      attempt.kind !== "lifecycle" &&
      attempt.operation !== "bbgm_get_state",
  );

  for (const record of behavioralRecords) {
    toolCallCounts[record.toolName] =
      (toolCallCounts[record.toolName] ?? 0) + 1;
    if (record.step === "mutation") {
      mutationSteps += 1;
      latencySum += record.latencyMs;
      transactionCount += record.events.filter((event) =>
        ["trade", "release", "sign", "draft", "contract_extension"].includes(
          event.type,
        ),
      ).length;
      if (
        record.invariantResults.some(
          (status) => status.kind === "hard" && !status.satisfied,
        )
      ) {
        invalidActionCount += 1;
      }
    }
    if (record.step === "checkpoint") checkpointCount += 1;
  }

  return {
    totalSteps: behavioralRecords.length,
    mutationSteps,
    rollbackCount: records.length - behavioralRecords.length,
    toolCallCounts,
    invalidActionCount,
    transactionCount,
    averageLatencyMs: mutationSteps === 0 ? 0 : latencySum / mutationSteps,
    agentAttemptCount: agentAttempts.length,
    rejectedAttemptCount: agentAttempts.filter(
      (attempt) => attempt.outcome === "rejected",
    ).length,
    staleActionCount: agentAttempts.filter(
      (attempt) => attempt.outcomeCode === "REVISION_CONFLICT",
    ).length,
    idempotentReplayCount: agentAttempts.filter(
      (attempt) => attempt.outcome === "idempotent_replay",
    ).length,
    checkpointCount,
  };
};
