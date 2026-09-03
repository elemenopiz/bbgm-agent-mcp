import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConstraintStatus, EngineEvent } from "../domain/types.js";
import { recoverJsonlSequence } from "./jsonl.js";

export type TrajectoryRecord = {
  episodeId: string;
  sequence: number;
  /** Wall-clock timestamp for audit only; never used in stateHash or any determinism comparison. */
  timestamp: string;
  step:
    "create_episode" | "checkpoint" | "mutation" | "rollback" | "end_episode";
  toolName: string;
  args: Record<string, unknown>;
  preStateHash: string | null;
  postStateHash: string;
  revision: number;
  normalizedAction: Record<string, unknown>;
  events: EngineEvent[];
  invariantResults: ConstraintStatus[];
  latencyMs: number;
  engine: { name: string; version: string; commit?: string };
  wrapperVersion: string;
  /** Present only for an explicit rejected-action rollback audit node. */
  rollback?: {
    outcomeCode: string;
    rollbackRequired: boolean;
    restoredStateHash: string;
  };
};

export const trajectoryPathFor = (
  dataRoot: string,
  episodeId: string,
): string => join(dataRoot, "episodes", episodeId, "trajectory.jsonl");

export const recoverTrajectorySequence = (
  path: string,
  episodeId: string,
): Promise<number> => recoverJsonlSequence(path, episodeId, "trajectory");

/** Serializes appends per episode so concurrent writers can never interleave a partial JSON line. */
export class TrajectoryWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(record: TrajectoryRecord): Promise<void> {
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    // A failed append must not permanently poison the queue. Callers still
    // receive the failed promise, but a later attempt can recover and write.
    this.queue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
