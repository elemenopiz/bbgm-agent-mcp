import { randomUUID } from "node:crypto";

import type {
  SimulationEngine,
  SimulationEngineFactory,
} from "../domain/SimulationEngine.js";
import { episodeStateHash } from "../domain/stateHash.js";
import { DomainError } from "../domain/errors.js";
import {
  DEFAULT_ALLOWED_ACTIONS,
  DEFAULT_ALLOWED_INFORMATION,
  type Checkpoint,
  type CreateEpisodeInput,
  type IdempotencyRecord,
} from "../domain/types.js";
import { createLogger } from "../logging/logger.js";
import {
  createFileEpisodeMetadataStore,
  type EpisodeMetadataStore,
  type PersistedEpisode,
} from "../persistence/episodes.js";
import {
  AttemptWriter,
  attemptLogPathFor,
  recoverAttemptSequence,
} from "../persistence/attemptLog.js";
import {
  TrajectoryWriter,
  recoverTrajectorySequence,
  trajectoryPathFor,
} from "../persistence/trajectoryLog.js";
import type { EpisodeRecord } from "./EpisodeStore.js";
import { EpisodeStore } from "./EpisodeStore.js";
import { WRAPPER_VERSION } from "../version.js";

const MAX_CONCURRENT_EPISODES = 50;

const logger = createLogger("EpisodeManager");

export type CreateEpisodeRequest = Omit<CreateEpisodeInput, "episodeId"> & {
  initialSnapshotHash?: string;
};

/**
 * Owns episode lifecycle: spinning up an isolated engine per episode,
 * registering it in the EpisodeStore, and tearing it down. Deliberately has
 * no knowledge of revisions, idempotency, or invariants -- see DomainService.
 */
export class EpisodeManager {
  readonly store = new EpisodeStore();

  constructor(
    private readonly engineFactory: SimulationEngineFactory,
    private readonly dataRoot: string,
    private readonly metadataStore: EpisodeMetadataStore = createFileEpisodeMetadataStore(
      dataRoot,
    ),
  ) {}

  private pendingCreates = 0;
  private readonly metadataQueues = new Map<string, Promise<void>>();
  private readonly resumeQueues = new Map<string, Promise<void>>();

  async create(request: CreateEpisodeRequest): Promise<EpisodeRecord> {
    this.pendingCreates += 1;
    const episodeId = randomUUID().replaceAll("-", "");
    let engine: SimulationEngine | undefined;
    let record: EpisodeRecord | undefined;
    try {
      const activeIds = new Set(
        this.store
          .list()
          .filter((episode) => episode.status === "active")
          .map((episode) => episode.episodeId),
      );
      for (const persisted of await this.metadataStore.list()) {
        if (persisted.status === "active") activeIds.add(persisted.episodeId);
      }
      if (activeIds.size + this.pendingCreates - 1 >= MAX_CONCURRENT_EPISODES) {
        throw new DomainError(
          "RESOURCE_LIMIT",
          `At most ${MAX_CONCURRENT_EPISODES} active episodes are allowed at once`,
        );
      }
      engine = this.engineFactory();
      const input: CreateEpisodeInput = { ...request, episodeId };
      await engine.create(input);

      record = this.buildRecord({
        episodeId,
        ...request,
        scenarioPolicy: request.scenarioPolicy ?? {
          allowedInformation: [...DEFAULT_ALLOWED_INFORMATION],
          allowedActions: [...DEFAULT_ALLOWED_ACTIONS],
        },
        engine,
        createdAt: new Date().toISOString(),
      });
      this.store.set(record);
      // DomainService owns the initial commit boundary. It writes the
      // current snapshot and state hash immediately after this returns, then
      // persists active metadata. Do not publish an active metadata record
      // here that has no current snapshot to resume from after a crash.
      logger.info("episode created", {
        episodeId,
        scenarioId: request.scenarioId,
        seed: request.seed,
      });
      return record;
    } catch (error) {
      if (record) this.store.delete(record.episodeId);
      if (engine) {
        await engine.close().catch((closeError: unknown) =>
          logger.error("error cleaning up failed episode creation", {
            episodeId,
            error:
              closeError instanceof Error
                ? closeError.message
                : String(closeError),
          }),
        );
      }
      throw error;
    } finally {
      this.pendingCreates -= 1;
    }
  }

  get(episodeId: string): EpisodeRecord {
    return this.store.require(episodeId);
  }

  getActive(episodeId: string): EpisodeRecord {
    return this.store.requireActive(episodeId);
  }

  async persist(record: EpisodeRecord): Promise<void> {
    if (record.status === "active" && record.lastStateHash === undefined) {
      throw new DomainError(
        "ENGINE_ERROR",
        "Cannot persist an active episode before its current snapshot is durable",
      );
    }
    const metadata: PersistedEpisode = {
      schemaVersion: "1",
      wrapperVersion: WRAPPER_VERSION,
      episodeId: record.episodeId,
      scenarioId: record.scenarioId,
      seed: record.seed,
      engine: record.engine.metadata,
      userTeamId: record.userTeamId,
      startingSeason: record.startingSeason,
      constraints: record.constraints,
      scenarioPolicy: record.scenarioPolicy,
      revision: record.revision,
      status: record.status,
      createdAt: record.createdAt,
      lastAccessedAt: record.lastAccessedAt,
      ...(record.lastStateHash === undefined
        ? {}
        : { stateHash: record.lastStateHash }),
      ...(record.initialSnapshotHash === undefined
        ? {}
        : { initialSnapshotHash: record.initialSnapshotHash }),
      trajectorySequence: record.trajectorySequence,
      invariantViolationCount: record.invariantViolationCount,
      transactionEventCount: record.transactionEventCount,
      stepCount: record.stepCount,
      attemptSequence: record.attemptSequence,
      checkpoints: [...record.checkpoints.values()],
      idempotency: Object.fromEntries(record.idempotency.entries()),
      ...(record.finalRawState === undefined
        ? {}
        : { finalRawState: record.finalRawState }),
    };
    const previous =
      this.metadataQueues.get(record.episodeId) ?? Promise.resolve();
    const write = previous.then(() => this.metadataStore.write(metadata));
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.metadataQueues.set(record.episodeId, settled);
    try {
      await write;
    } finally {
      if (this.metadataQueues.get(record.episodeId) === settled) {
        this.metadataQueues.delete(record.episodeId);
      }
    }
  }

  async readPersisted(episodeId: string): Promise<PersistedEpisode> {
    return this.metadataStore.read(episodeId);
  }

  async listPersisted(): Promise<PersistedEpisode[]> {
    return this.metadataStore.list();
  }

  /** Rehydrates an episode from durable metadata and its current snapshot. */
  async resume(episodeId: string, snapshot: unknown): Promise<EpisodeRecord> {
    const previous = this.resumeQueues.get(episodeId) ?? Promise.resolve();
    const operation = previous.then(() => this.resumeOnce(episodeId, snapshot));
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.resumeQueues.set(episodeId, settled);
    try {
      return await operation;
    } finally {
      if (this.resumeQueues.get(episodeId) === settled) {
        this.resumeQueues.delete(episodeId);
      }
    }
  }

  private async resumeOnce(
    episodeId: string,
    snapshot: unknown,
  ): Promise<EpisodeRecord> {
    const existing = this.store
      .list()
      .find((item) => item.episodeId === episodeId);
    if (existing && existing.status !== "quarantined") return existing;

    const metadata = await this.metadataStore.read(episodeId);
    if (existing?.status === "quarantined") {
      await existing.queue;
      await existing.engine.close().catch((error: unknown) =>
        logger.error("error replacing quarantined episode engine", {
          episodeId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      this.store.delete(episodeId);
    }

    if (metadata.status === "active" && metadata.stateHash === undefined) {
      await this.quarantineMetadata(metadata);
      throw new DomainError(
        "ENGINE_ERROR",
        "Persisted active episode is missing its state hash",
      );
    }

    let attemptSequence: number;
    let trajectorySequence: number;
    try {
      attemptSequence = Math.max(
        metadata.attemptSequence,
        await recoverAttemptSequence(
          attemptLogPathFor(this.dataRoot, episodeId),
          episodeId,
        ),
      );
      trajectorySequence = Math.max(
        metadata.trajectorySequence,
        await recoverTrajectorySequence(
          trajectoryPathFor(this.dataRoot, episodeId),
          episodeId,
        ),
      );
    } catch (error) {
      await this.quarantineMetadata(metadata);
      throw new DomainError(
        "ENGINE_ERROR",
        "Persisted episode audit logs are corrupt and cannot be resumed",
        {
          details: {
            episodeId,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }

    const engine = this.engineFactory();
    try {
      if (
        engine.metadata.name !== metadata.engine.name ||
        engine.metadata.version !== metadata.engine.version ||
        engine.metadata.commit !== metadata.engine.commit
      ) {
        throw new DomainError(
          "ENGINE_ERROR",
          "Persisted episode requires a different engine version",
          {
            details: {
              persistedEngine: metadata.engine,
              currentEngine: engine.metadata,
            },
          },
        );
      }
      await engine.importSnapshot(snapshot);
      if (metadata.stateHash !== undefined) {
        const state = await engine.getRawState();
        const importedHash = episodeStateHash(metadata.revision, state);
        if (importedHash !== metadata.stateHash) {
          await this.quarantineMetadata(metadata);
          throw new DomainError(
            "ENGINE_ERROR",
            "Persisted episode state does not match its recorded state hash",
            { details: { episodeId, revision: metadata.revision } },
          );
        }
      }
      const record = this.buildRecord({
        episodeId: metadata.episodeId,
        scenarioId: metadata.scenarioId,
        seed: metadata.seed,
        userTeamId: metadata.userTeamId,
        startingSeason: metadata.startingSeason,
        constraints: metadata.constraints,
        scenarioPolicy: metadata.scenarioPolicy,
        engine,
        createdAt: metadata.createdAt,
        revision: metadata.revision,
        status: metadata.status,
        lastAccessedAt: metadata.lastAccessedAt,
        ...(metadata.stateHash === undefined
          ? {}
          : { lastStateHash: metadata.stateHash }),
        ...(metadata.initialSnapshotHash === undefined
          ? {}
          : { initialSnapshotHash: metadata.initialSnapshotHash }),
        trajectorySequence,
        invariantViolationCount: metadata.invariantViolationCount,
        transactionEventCount: metadata.transactionEventCount,
        stepCount: metadata.stepCount,
        attemptSequence,
        ...(metadata.finalRawState === undefined
          ? {}
          : { finalRawState: metadata.finalRawState }),
        idempotency: new Map(Object.entries(metadata.idempotency)),
        checkpoints: new Map(
          metadata.checkpoints.map((checkpoint) => [
            checkpoint.checkpointId,
            checkpoint,
          ]),
        ),
      });
      this.store.set(record);
      try {
        // Persist recovered counters before exposing the rehydrated record so
        // a second crash cannot reuse a sequence that was only discovered in
        // the append-only logs.
        await this.persist(record);
      } catch (error) {
        this.store.delete(record.episodeId);
        throw error;
      }
      logger.info("episode resumed", {
        episodeId,
        revision: record.revision,
        status: record.status,
      });
      return record;
    } catch (error) {
      await engine.close().catch((closeError: unknown) =>
        logger.error("error cleaning up failed episode resume", {
          episodeId,
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        }),
      );
      throw error;
    }
  }

  private async quarantineMetadata(metadata: PersistedEpisode): Promise<void> {
    if (metadata.status === "quarantined") return;
    await this.metadataStore.write({ ...metadata, status: "quarantined" });
  }

  async dispose(episodeId: string): Promise<void> {
    const record = this.store.require(episodeId);
    await record.queue;
    await record.trajectoryWriter.flush();
    await record.attemptWriter.flush();
    record.status = "ended";
    try {
      // An episode that failed before its first current-snapshot commit was
      // never visible to a caller and must not leave resumable metadata.
      if (record.lastStateHash !== undefined) await this.persist(record);
    } finally {
      await record.engine.close();
    }
    logger.info("episode disposed", { episodeId });
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      this.store
        .list()
        // Already-ended episodes had dispose() (and therefore engine.close())
        // called for them already; closing again would just reject against an
        // already-terminated worker and log a spurious error.
        .filter((record) => record.status !== "ended")
        .map(async (record) => {
          try {
            // Shutdown closes the worker but preserves active status so a
            // later process can resume from current-snapshot.json.
            await record.queue;
            await record.trajectoryWriter.flush();
            await record.attemptWriter.flush();
            if (record.lastStateHash !== undefined) await this.persist(record);
            await record.engine.close();
          } catch (error) {
            logger.error("error closing episode engine", {
              episodeId: record.episodeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    );
  }

  private buildRecord(input: {
    episodeId: string;
    scenarioId: string;
    seed: string;
    userTeamId: number;
    startingSeason: number;
    constraints: EpisodeRecord["constraints"];
    scenarioPolicy: EpisodeRecord["scenarioPolicy"];
    initialSnapshotHash?: string;
    engine: SimulationEngine;
    createdAt: string;
    revision?: number;
    status?: EpisodeRecord["status"];
    lastAccessedAt?: string;
    lastStateHash?: string;
    trajectorySequence?: number;
    invariantViolationCount?: number;
    transactionEventCount?: number;
    stepCount?: number;
    attemptSequence?: number;
    finalRawState?: EpisodeRecord["finalRawState"];
    idempotency?: EpisodeRecord["idempotency"];
    checkpoints?: EpisodeRecord["checkpoints"];
  }): EpisodeRecord {
    return {
      episodeId: input.episodeId,
      scenarioId: input.scenarioId,
      seed: input.seed,
      userTeamId: input.userTeamId,
      startingSeason: input.startingSeason,
      constraints: input.constraints,
      scenarioPolicy: input.scenarioPolicy,
      ...(input.initialSnapshotHash === undefined
        ? {}
        : { initialSnapshotHash: input.initialSnapshotHash }),
      engine: input.engine,
      trajectoryWriter: new TrajectoryWriter(
        trajectoryPathFor(this.dataRoot, input.episodeId),
      ),
      attemptWriter: new AttemptWriter(
        attemptLogPathFor(this.dataRoot, input.episodeId),
      ),
      createdAt: input.createdAt,
      revision: input.revision ?? 0,
      status: input.status ?? "active",
      lastAccessedAt: input.lastAccessedAt ?? input.createdAt,
      ...(input.lastStateHash === undefined
        ? {}
        : { lastStateHash: input.lastStateHash }),
      trajectorySequence: input.trajectorySequence ?? 0,
      invariantViolationCount: input.invariantViolationCount ?? 0,
      transactionEventCount: input.transactionEventCount ?? 0,
      stepCount: input.stepCount ?? 0,
      attemptSequence: input.attemptSequence ?? 0,
      ...(input.finalRawState === undefined
        ? {}
        : { finalRawState: input.finalRawState }),
      queue: Promise.resolve(),
      idempotency: input.idempotency ?? new Map<string, IdempotencyRecord>(),
      checkpoints: input.checkpoints ?? new Map<string, Checkpoint>(),
    };
  }
}
