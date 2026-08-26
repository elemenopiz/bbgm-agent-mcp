import { readFile } from "node:fs/promises";

export type { TrajectoryRecord } from "../persistence/trajectoryLog.js";
import type { TrajectoryRecord } from "../persistence/trajectoryLog.js";

export const readTrajectory = async (
  path: string,
): Promise<TrajectoryRecord[]> => {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TrajectoryRecord);
};

export type TrajectorySummary = {
  totalSteps: number;
  mutationSteps: number;
  toolCallCounts: Record<string, number>;
  invalidActionCount: number;
  transactionCount: number;
  averageLatencyMs: number;
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
): TrajectorySummary => {
  const toolCallCounts: Record<string, number> = {};
  let transactionCount = 0;
  let invalidActionCount = 0;
  let latencySum = 0;
  let mutationSteps = 0;

  for (const record of records) {
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
  }

  return {
    totalSteps: records.length,
    mutationSteps,
    toolCallCounts,
    invalidActionCount,
    transactionCount,
    averageLatencyMs: mutationSteps === 0 ? 0 : latencySum / mutationSteps,
  };
};
