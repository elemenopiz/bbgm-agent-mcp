import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "./atomicWrite.js";

/**
 * Filesystem-backed checkpoint storage. Tools only ever see opaque checkpoint
 * IDs; the on-disk path is an internal implementation detail derived from the
 * (already-validated) episodeId and a server-generated checkpointId, never
 * from caller-supplied paths.
 */
export type SnapshotStore = {
  write(
    episodeId: string,
    checkpointId: string,
    snapshot: unknown,
  ): Promise<void>;
  read(episodeId: string, checkpointId: string): Promise<unknown>;
  writeFinal(episodeId: string, snapshot: unknown): Promise<string>;
};

export const createFileSnapshotStore = (dataRoot: string): SnapshotStore => {
  const episodeDir = (episodeId: string): string =>
    join(dataRoot, "episodes", episodeId, "checkpoints");
  const checkpointPath = (episodeId: string, checkpointId: string): string =>
    join(episodeDir(episodeId), `${checkpointId}.json`);

  return {
    async write(episodeId, checkpointId, snapshot) {
      await atomicWriteFile(
        checkpointPath(episodeId, checkpointId),
        JSON.stringify(snapshot),
      );
    },
    async read(episodeId, checkpointId) {
      const raw = await readFile(
        checkpointPath(episodeId, checkpointId),
        "utf8",
      );
      return JSON.parse(raw) as unknown;
    },
    async writeFinal(episodeId, snapshot) {
      const path = join(dataRoot, "episodes", episodeId, "final-snapshot.json");
      await atomicWriteFile(path, JSON.stringify(snapshot));
      return path;
    },
  };
};
