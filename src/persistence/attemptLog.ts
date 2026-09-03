import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import { recoverJsonlSequence } from "./jsonl.js";

export type AttemptRecord = {
  episodeId: string;
  sequence: number;
  timestamp: string;
  operation: string;
  kind: "read" | "mutation" | "lifecycle";
  actor?: "agent" | "evaluator";
  outcome: "accepted" | "idempotent_replay" | "rejected";
  outcomeCode?: string;
  retryable?: boolean;
  /** Structured, non-secret failure context retained for research analysis. */
  details?: Record<string, unknown>;
  expectedRevision?: number;
  observedRevision?: number;
  idempotencyKey?: string;
  inputHash?: string;
};

export const attemptLogPathFor = (
  dataRoot: string,
  episodeId: string,
): string => join(dataRoot, "episodes", episodeId, "attempts.jsonl");

export const recoverAttemptSequence = (
  path: string,
  episodeId: string,
): Promise<number> => recoverJsonlSequence(path, episodeId, "attempt");

/** Serializes append-only behavioral audit records per episode. */
export class AttemptWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(record: AttemptRecord): Promise<void> {
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
