import type { SimulationEngine } from "../domain/SimulationEngine.js";
import { DomainError } from "../domain/errors.js";
import type {
  Checkpoint,
  EngineRawState,
  EpisodeStatus,
  MutationResult,
  ScenarioConstraintSpec,
} from "../domain/types.js";
import type { TrajectoryWriter } from "../persistence/trajectoryLog.js";

export type EpisodeRecord = {
  readonly episodeId: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly userTeamId: number;
  readonly startingSeason: number;
  readonly constraints: ScenarioConstraintSpec;
  readonly engine: SimulationEngine;
  readonly trajectoryWriter: TrajectoryWriter;
  readonly createdAt: string;

  revision: number;
  status: EpisodeStatus;
  lastAccessedAt: string;
  trajectorySequence: number;
  invariantViolationCount: number;
  transactionEventCount: number;
  /**
   * Snapshot of the engine's last-observed raw state, captured right before
   * `dispose()` closes the engine (which, for the real worker-backed engine,
   * terminates the worker). Reads against an ended episode are served from
   * this cache instead of calling into a (possibly already-terminated)
   * engine, so "an ended episode stays readable" holds for every engine
   * implementation, not just ones where close() happens to be a no-op.
   */
  finalRawState?: EngineRawState;
  /** Promise chain enforcing one in-flight engine mutation at a time. */
  queue: Promise<void>;
  readonly idempotency: Map<string, MutationResult>;
  readonly checkpoints: Map<string, Checkpoint>;
};

/**
 * Pure session bookkeeping: episodeId -> engine handle plus the metadata and
 * concurrency primitives needed to serialize access to it. Contains no
 * business rules or invariant logic -- that belongs to DomainService.
 */
export class EpisodeStore {
  private readonly episodes = new Map<string, EpisodeRecord>();

  set(record: EpisodeRecord): void {
    this.episodes.set(record.episodeId, record);
  }

  require(episodeId: string): EpisodeRecord {
    const record = this.episodes.get(episodeId);
    if (!record)
      throw new DomainError(
        "EPISODE_NOT_FOUND",
        `Unknown episode: ${episodeId}`,
      );
    record.lastAccessedAt = new Date().toISOString();
    return record;
  }

  requireActive(episodeId: string): EpisodeRecord {
    const record = this.require(episodeId);
    if (record.status !== "active") {
      throw new DomainError(
        "ILLEGAL_ACTION",
        `Episode ${episodeId} has already ended`,
      );
    }
    return record;
  }

  delete(episodeId: string): void {
    this.episodes.delete(episodeId);
  }

  list(): EpisodeRecord[] {
    return [...this.episodes.values()];
  }
}
