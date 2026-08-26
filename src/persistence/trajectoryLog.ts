import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConstraintStatus, EngineEvent } from "../domain/types.js";

export type TrajectoryRecord = {
  episodeId: string;
  sequence: number;
  /** Wall-clock timestamp for audit only; never used in stateHash or any determinism comparison. */
  timestamp: string;
  step: "create_episode" | "mutation" | "end_episode";
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
};

export const trajectoryPathFor = (
  dataRoot: string,
  episodeId: string,
): string => join(dataRoot, "episodes", episodeId, "trajectory.jsonl");

/** Serializes appends per episode so concurrent writers can never interleave a partial JSON line. */
export class TrajectoryWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(record: TrajectoryRecord): Promise<void> {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    });
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
