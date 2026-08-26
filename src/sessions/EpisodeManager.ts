import { randomUUID } from "node:crypto";

import { DomainError } from "../domain/errors.js";
import type { SimulationEngineFactory } from "../domain/SimulationEngine.js";
import { stateHash } from "../domain/stateHash.js";
import type {
  AdvanceInput,
  Checkpoint,
  CreateEpisodeInput,
  LeagueState,
  MutationContext,
  MutationResult,
  TradeEvaluation,
  TradeProposal,
} from "../domain/types.js";

type Episode = {
  engine: ReturnType<SimulationEngineFactory>;
  revision: number;
  status: "active" | "ended";
  queue: Promise<void>;
  idempotency: Map<string, MutationResult>;
  checkpoints: Map<string, { metadata: Checkpoint; snapshot: unknown }>;
};

export class EpisodeManager {
  private readonly episodes = new Map<string, Episode>();

  constructor(private readonly engineFactory: SimulationEngineFactory) {}

  async create(input: Omit<CreateEpisodeInput, "episodeId">): Promise<LeagueState> {
    const episodeId = randomUUID().replaceAll("-", "");
    const engine = this.engineFactory();
    await engine.create({ ...input, episodeId });
    this.episodes.set(episodeId, {
      engine,
      revision: 0,
      status: "active",
      queue: Promise.resolve(),
      idempotency: new Map(),
      checkpoints: new Map(),
    });
    return this.getState(episodeId);
  }

  async getState(episodeId: string): Promise<LeagueState> {
    const episode = this.requireEpisode(episodeId);
    const state = await episode.engine.getState();
    const withoutHash = {
      ...state,
      status: episode.status,
      revision: episode.revision,
    };
    const { episodeId: _episodeId, ...deterministicState } = withoutHash;
    return { ...withoutHash, stateHash: stateHash(deterministicState) };
  }

  async getOptions(episodeId: string): Promise<{ episodeId: string; revision: number; options: Array<Record<string, unknown>> }> {
    const episode = this.requireActiveEpisode(episodeId);
    return {
      episodeId,
      revision: episode.revision,
      options: await episode.engine.getOptions(),
    };
  }

  async evaluateTrade(episodeId: string, proposal: TradeProposal): Promise<TradeEvaluation> {
    return this.requireActiveEpisode(episodeId).engine.evaluateTrade(proposal);
  }

  async advance(
    episodeId: string,
    input: AdvanceInput,
    context: MutationContext,
  ): Promise<MutationResult> {
    return this.mutate(episodeId, context, { type: "advance", ...input }, (episode) =>
      episode.engine.advance(input),
    );
  }

  async executeTrade(
    episodeId: string,
    proposal: TradeProposal,
    context: MutationContext,
  ): Promise<MutationResult> {
    return this.mutate(episodeId, context, { type: "trade", ...proposal }, (episode) =>
      episode.engine.executeTrade(proposal),
    );
  }

  async createCheckpoint(episodeId: string): Promise<Checkpoint> {
    const episode = this.requireActiveEpisode(episodeId);
    const state = await this.getState(episodeId);
    const checkpointId = randomUUID().replaceAll("-", "");
    const metadata: Checkpoint = {
      checkpointId,
      episodeId,
      revision: episode.revision,
      stateHash: state.stateHash,
      createdAt: new Date().toISOString(),
    };
    episode.checkpoints.set(checkpointId, {
      metadata,
      snapshot: await episode.engine.exportSnapshot(),
    });
    return metadata;
  }

  listCheckpoints(episodeId: string): Checkpoint[] {
    return [...this.requireEpisode(episodeId).checkpoints.values()].map(({ metadata }) => metadata);
  }

  async restoreCheckpoint(
    episodeId: string,
    checkpointId: string,
    context: MutationContext,
  ): Promise<MutationResult> {
    return this.mutate(episodeId, context, { type: "restore_checkpoint", checkpointId }, async (episode) => {
      const checkpoint = episode.checkpoints.get(checkpointId);
      if (!checkpoint) {
        throw new DomainError("ILLEGAL_ACTION", `Unknown checkpoint: ${checkpointId}`);
      }
      await episode.engine.importSnapshot(checkpoint.snapshot);
      return [{ type: "checkpoint_restored", checkpointId }];
    });
  }

  async end(episodeId: string): Promise<LeagueState> {
    const episode = this.requireActiveEpisode(episodeId);
    episode.status = "ended";
    const state = await this.getState(episodeId);
    await episode.engine.close();
    return state;
  }

  async close(): Promise<void> {
    await Promise.all([...this.episodes.values()].map(({ engine }) => engine.close()));
    this.episodes.clear();
  }

  private async mutate(
    episodeId: string,
    context: MutationContext,
    appliedAction: Record<string, unknown>,
    operation: (episode: Episode) => Promise<Array<Record<string, unknown>>>,
  ): Promise<MutationResult> {
    const episode = this.requireActiveEpisode(episodeId);
    const previous = episode.idempotency.get(context.idempotencyKey);
    if (previous) return previous;

    let result!: MutationResult;
    let failure: unknown;
    episode.queue = episode.queue.then(async () => {
      try {
        if (episode.revision !== context.expectedRevision) {
          throw new DomainError("REVISION_CONFLICT", "Episode revision is stale", {
            retryable: true,
            details: { expectedRevision: context.expectedRevision, currentRevision: episode.revision },
          });
        }
        const rollback = await episode.engine.exportSnapshot();
        const previousRevision = episode.revision;
        try {
          const events = await operation(episode);
          episode.revision += 1;
          const nextState = await this.getState(episodeId);
          const failedConstraints = nextState.constraints.filter(({ satisfied }) => !satisfied);
          if (failedConstraints.length > 0) {
            throw new DomainError("INVARIANT_VIOLATION", "Mutation violated episode constraints", {
              details: { failedConstraints },
            });
          }
          result = {
            episodeId,
            previousRevision,
            revision: episode.revision,
            stateHash: nextState.stateHash,
            appliedAction,
            events,
            warnings: [],
            nextDecision: nextState.nextDecision,
          };
          episode.idempotency.set(context.idempotencyKey, result);
        } catch (error) {
          episode.revision = previousRevision;
          await episode.engine.importSnapshot(rollback);
          throw error;
        }
      } catch (error) {
        failure = error;
      }
    });
    await episode.queue;
    if (failure) throw failure;
    return result;
  }

  private requireEpisode(episodeId: string): Episode {
    const episode = this.episodes.get(episodeId);
    if (!episode) throw new DomainError("EPISODE_NOT_FOUND", `Unknown episode: ${episodeId}`);
    return episode;
  }

  private requireActiveEpisode(episodeId: string): Episode {
    const episode = this.requireEpisode(episodeId);
    if (episode.status !== "active") {
      throw new DomainError("ILLEGAL_ACTION", `Episode ${episodeId} has ended`);
    }
    return episode;
  }
}
