import type { SimulationEngine } from "../domain/SimulationEngine.js";
import { DomainError } from "../domain/errors.js";
import type {
  Checkpoint,
  EngineRawState,
  EpisodeStatus,
  IdempotencyRecord,
  ScenarioConstraintSpec,
  ScenarioPolicy,
} from "../domain/types.js";
import type { TrajectoryWriter } from "../persistence/trajectoryLog.js";
import type { AttemptWriter } from "../persistence/attemptLog.js";

export type EpisodeRecord = {
  readonly episodeId: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly userTeamId: number;
  readonly startingSeason: number;
  readonly constraints: ScenarioConstraintSpec;
  readonly scenarioPolicy: ScenarioPolicy;
  readonly initialSnapshotHash?: string;
  readonly engine: SimulationEngine;
  readonly trajectoryWriter: TrajectoryWriter;
  readonly attemptWriter: AttemptWriter;
  readonly createdAt: string;

  revision: number;
  status: EpisodeStatus;
  lastAccessedAt: string;
  trajectorySequence: number;
  invariantViolationCount: number;
  transactionEventCount: number;
  stepCount: number;
  attemptSequence: number;
  /**
   * Snapshot of the engine's last-observed raw state, captured right before
   * `dispose()` closes the engine (which, for the real worker-backed engine,
   * terminates the worker). Reads against an ended episode are served from
   * this cache instead of calling into a (possibly already-terminated)
   * engine, so "an ended episode stays readable" holds for every engine
   * implementation, not just ones where close() happens to be a no-op.
   */
  finalRawState?: EngineRawState;
  /** Hash of the latest durable current snapshot, when one has been written. */
  lastStateHash?: string;
  /** Promise chain enforcing one in-flight engine mutation at a time. */
  queue: Promise<void>;
  readonly idempotency: Map<string, IdempotencyRecord>;
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
        `Episode ${episodeId} is not active (status: ${record.status})`,
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
