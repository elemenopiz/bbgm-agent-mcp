import { randomUUID } from "node:crypto";

import type { SimulationEngineFactory } from "../domain/SimulationEngine.js";
import { DomainError } from "../domain/errors.js";
import type { CreateEpisodeInput } from "../domain/types.js";
import { createLogger } from "../logging/logger.js";
import {
  TrajectoryWriter,
  trajectoryPathFor,
} from "../persistence/trajectoryLog.js";
import type { EpisodeRecord } from "./EpisodeStore.js";
import { EpisodeStore } from "./EpisodeStore.js";

const MAX_CONCURRENT_EPISODES = 50;

const logger = createLogger("EpisodeManager");

export type CreateEpisodeRequest = Omit<CreateEpisodeInput, "episodeId">;

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
  ) {}

  async create(request: CreateEpisodeRequest): Promise<EpisodeRecord> {
    if (
      this.store.list().filter((episode) => episode.status === "active")
        .length >= MAX_CONCURRENT_EPISODES
    ) {
      throw new DomainError(
        "RESOURCE_LIMIT",
        `At most ${MAX_CONCURRENT_EPISODES} active episodes are allowed at once`,
      );
    }

    const episodeId = randomUUID().replaceAll("-", "");
    const engine = this.engineFactory();
    const input: CreateEpisodeInput = { ...request, episodeId };
    await engine.create(input);

    const now = new Date().toISOString();
    const record: EpisodeRecord = {
      episodeId,
      scenarioId: request.scenarioId,
      seed: request.seed,
      userTeamId: request.userTeamId,
      startingSeason: request.startingSeason,
      constraints: request.constraints,
      engine,
      trajectoryWriter: new TrajectoryWriter(
        trajectoryPathFor(this.dataRoot, episodeId),
      ),
      createdAt: now,
      revision: 0,
      status: "active",
      lastAccessedAt: now,
      trajectorySequence: 0,
      invariantViolationCount: 0,
      transactionEventCount: 0,
      queue: Promise.resolve(),
      idempotency: new Map(),
      checkpoints: new Map(),
    };
    this.store.set(record);
    logger.info("episode created", {
      episodeId,
      scenarioId: request.scenarioId,
      seed: request.seed,
    });
    return record;
  }

  get(episodeId: string): EpisodeRecord {
    return this.store.require(episodeId);
  }

  getActive(episodeId: string): EpisodeRecord {
    return this.store.requireActive(episodeId);
  }

  async dispose(episodeId: string): Promise<void> {
    const record = this.store.require(episodeId);
    record.status = "ended";
    await record.trajectoryWriter.flush();
    await record.engine.close();
    logger.info("episode disposed", { episodeId });
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      this.store
        .list()
        // Already-ended episodes had dispose() (and therefore engine.close())
        // called for them already; closing again would just reject against an
        // already-terminated worker and log a spurious error.
        .filter((record) => record.status === "active")
        .map(async (record) => {
          try {
            record.status = "ended";
            await record.trajectoryWriter.flush();
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
}
