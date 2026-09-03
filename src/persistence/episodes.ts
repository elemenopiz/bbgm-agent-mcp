import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import * as z from "zod/v4";

import {
  checkpointSchema,
  engineMetadataSchema,
  idempotencyRecordSchema,
  scenarioPolicySchema,
  scenarioConstraintSpecSchema,
} from "../domain/schemas.js";
import type {
  Checkpoint,
  EngineMetadata,
  EngineRawState,
  IdempotencyRecord,
  ScenarioConstraintSpec,
  AdvanceTarget,
} from "../domain/types.js";
import { atomicWriteFile } from "./atomicWrite.js";

export class EpisodeMetadataError extends Error {
  readonly code = "PERSISTENCE_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "EpisodeMetadataError";
  }
}

const persistedEpisodeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    wrapperVersion: z.string().min(1).optional(),
    episodeId: z.string().min(1),
    scenarioId: z.string().min(1),
    seed: z.string().min(1),
    engine: engineMetadataSchema,
    userTeamId: z.number().int().nonnegative(),
    startingSeason: z.number().int(),
    constraints: scenarioConstraintSpecSchema,
    scenarioPolicy: scenarioPolicySchema,
    revision: z.number().int().nonnegative(),
    status: z.enum(["active", "ended", "quarantined"]),
    createdAt: z.string().datetime(),
    lastAccessedAt: z.string().datetime(),
    stateHash: z.string().length(64).optional(),
    initialSnapshotHash: z.string().length(64).optional(),
    trajectorySequence: z.number().int().nonnegative(),
    invariantViolationCount: z.number().int().nonnegative(),
    transactionEventCount: z.number().int().nonnegative(),
    stepCount: z.number().int().nonnegative(),
    attemptSequence: z.number().int().nonnegative(),
    checkpoints: z.array(checkpointSchema),
    idempotency: z.record(z.string(), idempotencyRecordSchema),
    finalRawState: z.unknown().optional(),
  })
  .strict();

export type PersistedEpisode = {
  schemaVersion: "1";
  wrapperVersion?: string;
  episodeId: string;
  scenarioId: string;
  seed: string;
  engine: EngineMetadata;
  userTeamId: number;
  startingSeason: number;
  constraints: ScenarioConstraintSpec;
  scenarioPolicy: {
    allowedInformation: string[];
    allowedActions: string[];
    allowedAdvanceTargets?: AdvanceTarget[] | undefined;
    maxSteps?: number | undefined;
    horizonSeasons?: number | undefined;
  };
  revision: number;
  status: "active" | "ended" | "quarantined";
  createdAt: string;
  lastAccessedAt: string;
  stateHash?: string;
  initialSnapshotHash?: string;
  trajectorySequence: number;
  invariantViolationCount: number;
  transactionEventCount: number;
  stepCount: number;
  attemptSequence: number;
  checkpoints: Checkpoint[];
  idempotency: Record<string, IdempotencyRecord>;
  finalRawState?: EngineRawState;
};

export type EpisodeMetadataStore = {
  write(metadata: PersistedEpisode): Promise<void>;
  read(episodeId: string): Promise<PersistedEpisode>;
  list(): Promise<PersistedEpisode[]>;
};

export const createFileEpisodeMetadataStore = (
  dataRoot: string,
): EpisodeMetadataStore => {
  const metadataPath = (episodeId: string): string =>
    join(dataRoot, "episodes", episodeId, "metadata.json");

  const parseMetadata = (raw: string, path: string): PersistedEpisode => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new EpisodeMetadataError(`Invalid episode metadata at ${path}`);
    }
    const result = persistedEpisodeSchema.safeParse(value);
    if (!result.success) {
      throw new EpisodeMetadataError(`Invalid episode metadata at ${path}`);
    }
    return result.data as PersistedEpisode;
  };

  const readMetadataPath = async (path: string): Promise<PersistedEpisode> => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EpisodeMetadataError(
          `Episode metadata is missing at ${path}`,
        );
      }
      throw error;
    }
    return parseMetadata(raw, path);
  };

  return {
    async write(metadata) {
      await atomicWriteFile(
        metadataPath(metadata.episodeId),
        JSON.stringify(metadata),
      );
    },
    async read(episodeId) {
      const path = metadataPath(episodeId);
      return readMetadataPath(path);
    },
    async list() {
      let entries;
      try {
        entries = await readdir(join(dataRoot, "episodes"), {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const directories = entries.filter((entry) => entry.isDirectory());
      const results = await Promise.all(
        directories.map(async (entry) => {
          const path = metadataPath(entry.name);
          try {
            return await readMetadataPath(path);
          } catch (error) {
            // A directory can be left behind if a process dies before the
            // first durable metadata commit. It is not a resumable episode,
            // so omit only that orphan; malformed metadata remains fatal so
            // capacity accounting cannot silently undercount active work.
            if (
              error instanceof EpisodeMetadataError &&
              error.message.startsWith("Episode metadata is missing")
            ) {
              return undefined;
            }
            throw error;
          }
        }),
      );
      return results.filter(
        (metadata): metadata is PersistedEpisode => metadata !== undefined,
      );
    },
  };
};
