import { randomUUID } from "node:crypto";

import type * as z from "zod/v4";

import { createLogger } from "../logging/logger.js";
import type { SnapshotStore } from "../persistence/snapshots.js";
import type { TrajectoryRecord } from "../persistence/trajectoryLog.js";
import type { CreateEpisodeRequest } from "../sessions/EpisodeManager.js";
import type { EpisodeManager } from "../sessions/EpisodeManager.js";
import type { EpisodeRecord } from "../sessions/EpisodeStore.js";
import { WRAPPER_VERSION } from "../version.js";
import { DomainError } from "./errors.js";
import {
  evaluateScenarioConstraints,
  hasHardFailure,
  runBuiltinInvariants,
} from "./invariants.js";
import {
  buildObjectivesFromSpec,
  buildOverviewView,
  buildView,
} from "./normalization.js";
import {
  advanceInputSchema,
  createEpisodeInputSchema,
  endEpisodeInputSchema,
  getStateInputSchema,
  makeDraftPickInputSchema,
  negotiateContractInputSchema,
  releasePlayerInputSchema,
  setLineupInputSchema,
  signFreeAgentInputSchema,
  tradeProposalSchema,
} from "./schemas.js";
import { stateHash } from "./stateHash.js";
import type {
  AdvanceInput,
  Checkpoint,
  ConstraintStatus,
  EndEpisodeInput,
  EndEpisodeResult,
  EngineEvent,
  EngineRawState,
  GetStateInput,
  LeagueStateView,
  MakeDraftPickInput,
  MutationContext,
  MutationResult,
  NegotiateContractInput,
  OptionsResult,
  OverviewView,
  Phase,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeEvaluation,
  TradeProposal,
} from "./types.js";

const logger = createLogger("DomainService");

const TRANSACTION_EVENT_TYPES = new Set([
  "trade",
  "release",
  "sign",
  "draft",
  "contract_extension",
]);

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Input failed schema validation",
      {
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    );
  }
  return result.data;
};

type MutationSpec = {
  toolName: string;
  appliedAction: Record<string, unknown>;
  args: Record<string, unknown>;
  requiredPhase?: Phase;
  disallowedPhases?: Phase[];
  legality?: (state: EngineRawState, record: EpisodeRecord) => void;
  execute: (record: EpisodeRecord) => Promise<EngineEvent[]>;
};

/**
 * Enforces invariants and concurrency on top of the episode/session layer.
 * This is the one place mutation legality, revision/idempotency bookkeeping,
 * rollback-on-invariant-failure, and trajectory logging happen. Both the MCP
 * tool layer and the offline research/evaluate CLI call this directly, so
 * semantics never drift between the two entry points.
 */
export class DomainService {
  constructor(
    private readonly episodes: EpisodeManager,
    private readonly snapshots: SnapshotStore,
  ) {}

  // -- lifecycle -------------------------------------------------------

  async createEpisode(rawInput: unknown): Promise<OverviewView> {
    const input = parse(createEpisodeInputSchema, rawInput);
    const request: CreateEpisodeRequest = {
      scenarioId: input.scenarioId,
      seed: input.seed,
      userTeamId: input.userTeamId,
      startingSeason: input.startingSeason,
      constraints: input.constraints ?? { hard: [], soft: [] },
      // (ObjectiveDefinition.targetValue is `number | undefined` precisely so this zod-parsed
      // value is directly assignable under exactOptionalPropertyTypes -- see domain/types.ts)
    };
    const record = await this.episodes.create(request);
    const state = await this.runQueued(record, () =>
      record.engine.getRawState(),
    );
    const hash = this.computeStateHash(record.revision, state);
    const constraints = this.evaluateConstraints(record, state);

    await record.trajectoryWriter.append(
      this.trajectoryRecord(record, {
        step: "create_episode",
        toolName: "bbgm_create_episode",
        args: request,
        preStateHash: null,
        postStateHash: hash,
        normalizedAction: {
          type: "create_episode",
          scenarioId: request.scenarioId,
          seed: request.seed,
        },
        events: [],
        invariantResults: constraints,
        latencyMs: 0,
      }),
    );

    return buildOverviewView(
      {
        episodeId: record.episodeId,
        revision: record.revision,
        stateHash: hash,
        state,
      },
      record.status,
      constraints,
    );
  }

  async endEpisode(
    episodeId: string,
    rawOptions: { exportFinalSnapshot?: boolean } = {},
  ): Promise<EndEpisodeResult> {
    const input: EndEpisodeInput = parse(endEpisodeInputSchema, {
      ...rawOptions,
      episodeId,
    });
    const record = this.episodes.getActive(episodeId);
    const state = await this.runQueued(record, () =>
      record.engine.getRawState(),
    );
    const hash = this.computeStateHash(record.revision, state);

    let snapshotCheckpointId: string | undefined;
    if (input.exportFinalSnapshot) {
      const checkpoint = await this.createCheckpointFor(record, state, hash);
      snapshotCheckpointId = checkpoint.checkpointId;
    }

    record.status = "ended";
    record.finalRawState = state;
    const constraints = this.evaluateConstraints(record, state);
    const finalState = buildOverviewView(
      {
        episodeId: record.episodeId,
        revision: record.revision,
        stateHash: hash,
        state,
      },
      record.status,
      constraints,
    );

    await record.trajectoryWriter.append(
      this.trajectoryRecord(record, {
        step: "end_episode",
        toolName: "bbgm_end_episode",
        args: { episodeId, exportFinalSnapshot: input.exportFinalSnapshot },
        preStateHash: hash,
        postStateHash: hash,
        normalizedAction: { type: "end_episode" },
        events: [],
        invariantResults: constraints,
        latencyMs: 0,
      }),
    );

    await this.episodes.dispose(episodeId);

    const result: EndEpisodeResult = {
      episodeId,
      finalState,
      terminalMetrics: {
        episodeId,
        seasonsCompleted: Math.max(0, state.season - record.startingSeason),
        finalRecord: { won: state.userTeam.won, lost: state.userTeam.lost },
        hardConstraintViolations: record.invariantViolationCount,
        transactionCount: record.transactionEventCount,
      },
      ...(snapshotCheckpointId === undefined ? {} : { snapshotCheckpointId }),
    };
    return result;
  }

  async closeAll(): Promise<void> {
    await this.episodes.closeAll();
  }

  // -- reads -------------------------------------------------------------

  async getState(rawInput: unknown): Promise<LeagueStateView> {
    const input: GetStateInput = parse(getStateInputSchema, rawInput);
    const record = this.episodes.get(input.episodeId);
    const state = await this.readRawState(record);
    const hash = this.computeStateHash(record.revision, state);
    const constraints = this.evaluateConstraints(record, state);
    const objectives = buildObjectivesFromSpec(record.constraints, state);
    return buildView(
      input.view,
      {
        episodeId: record.episodeId,
        revision: record.revision,
        stateHash: hash,
        state,
      },
      {
        status: record.status,
        constraints,
        objectives,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    );
  }

  async getOptions(episodeId: string): Promise<OptionsResult> {
    const record = this.episodes.getActive(episodeId);
    const options = await this.runQueued(record, () =>
      record.engine.getOptions(),
    );
    return { episodeId, revision: record.revision, options };
  }

  async evaluateTrade(
    episodeId: string,
    rawProposal: unknown,
  ): Promise<TradeEvaluation> {
    const proposal = parse(tradeProposalSchema, rawProposal);
    const record = this.episodes.getActive(episodeId);
    return this.runQueued(record, () => record.engine.evaluateTrade(proposal));
  }

  // -- mutations -----------------------------------------------------------

  async executeTrade(
    episodeId: string,
    rawProposal: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const proposal = parse(tradeProposalSchema, rawProposal);
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_execute_trade",
      appliedAction: { type: "execute_trade", ...proposal },
      args: { proposal },
      disallowedPhases: ["draft"],
      legality: (state) => this.assertLegalTrade(state, proposal),
      execute: (record) => record.engine.executeTrade(proposal),
    });
  }

  async setLineup(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: SetLineupInput = parse(setLineupInputSchema, rawInput);
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_set_lineup",
      appliedAction: { type: "set_lineup", order: input.order },
      args: { input },
      disallowedPhases: ["draft"],
      legality: (state) => {
        const rosterPids = new Set(state.roster.map((player) => player.pid));
        const orderSet = new Set(input.order);
        if (orderSet.size !== input.order.length) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            "Lineup order contains duplicate player IDs",
          );
        }
        if (
          orderSet.size !== rosterPids.size ||
          [...orderSet].some((pid) => !rosterPids.has(pid))
        ) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            "Lineup order must contain exactly the current roster's players",
          );
        }
      },
      execute: (record) => record.engine.setLineup(input),
    });
  }

  async releasePlayer(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: ReleasePlayerInput = parse(releasePlayerInputSchema, rawInput);
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_release_player",
      appliedAction: { type: "release_player", pid: input.pid },
      args: { input },
      disallowedPhases: ["draft"],
      legality: (state) => {
        if (!state.roster.some((player) => player.pid === input.pid)) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Player ${input.pid} is not on the user's roster`,
          );
        }
      },
      execute: (record) => record.engine.releasePlayer(input),
    });
  }

  async negotiateContract(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: NegotiateContractInput = parse(
      negotiateContractInputSchema,
      rawInput,
    );
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_negotiate_contract",
      appliedAction: { type: "negotiate_contract", ...input },
      args: { input },
      disallowedPhases: ["draft"],
      legality: (state) => {
        if (!state.roster.some((player) => player.pid === input.pid)) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Player ${input.pid} is not on the user's roster`,
          );
        }
      },
      execute: (record) => record.engine.negotiateContract(input),
    });
  }

  async signFreeAgent(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: SignFreeAgentInput = parse(signFreeAgentInputSchema, rawInput);
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_sign_free_agent",
      appliedAction: { type: "sign_free_agent", ...input },
      args: { input },
      disallowedPhases: ["draft"],
      legality: (state) => {
        if (!state.freeAgents.some((player) => player.pid === input.pid)) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Player ${input.pid} is not a free agent`,
          );
        }
      },
      execute: (record) => record.engine.signFreeAgent(input),
    });
  }

  async makeDraftPick(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: MakeDraftPickInput = parse(makeDraftPickInputSchema, rawInput);
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_make_draft_pick",
      appliedAction: { type: "make_draft_pick", pid: input.pid },
      args: { input },
      requiredPhase: "draft",
      legality: (state) => {
        if (
          !state.draftProspects.some((prospect) => prospect.pid === input.pid)
        ) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Prospect ${input.pid} is not an available draft prospect`,
          );
        }
        if (state.ownedPicks.length === 0) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            "No owned draft picks remain in this draft",
          );
        }
      },
      execute: (record) => record.engine.makeDraftPick(input),
    });
  }

  async advance(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: AdvanceInput = parse(advanceInputSchema, rawInput);
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_advance",
      appliedAction: { type: "advance", ...input },
      args: { input },
      execute: (record) => record.engine.advance(input),
    });
  }

  // -- checkpoints -----------------------------------------------------------

  async createCheckpoint(episodeId: string): Promise<Checkpoint> {
    const record = this.episodes.getActive(episodeId);
    const state = await this.runQueued(record, () =>
      record.engine.getRawState(),
    );
    const hash = this.computeStateHash(record.revision, state);
    return this.createCheckpointFor(record, state, hash);
  }

  listCheckpoints(episodeId: string): Checkpoint[] {
    return [...this.episodes.get(episodeId).checkpoints.values()];
  }

  async restoreCheckpoint(
    episodeId: string,
    checkpointId: string,
    context: MutationContext,
  ): Promise<MutationResult> {
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_checkpoint",
      appliedAction: { type: "restore_checkpoint", checkpointId },
      args: { checkpointId },
      legality: (_state, record) => {
        if (!record.checkpoints.has(checkpointId)) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Unknown checkpoint: ${checkpointId}`,
          );
        }
      },
      execute: async (record) => {
        const checkpoint = record.checkpoints.get(checkpointId);
        if (!checkpoint)
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Unknown checkpoint: ${checkpointId}`,
          );
        const snapshot = await this.snapshots.read(episodeId, checkpointId);
        await record.engine.importSnapshot(snapshot);
        return [
          {
            type: "checkpoint_restored",
            checkpointId,
            restoredRevision: checkpoint.revision,
          },
        ];
      },
    });
  }

  // -- internals -------------------------------------------------------------

  private async createCheckpointFor(
    record: EpisodeRecord,
    state: EngineRawState,
    hash: string,
  ): Promise<Checkpoint> {
    const snapshot = await this.runQueued(record, () =>
      record.engine.exportSnapshot(),
    );
    const checkpointId = randomUUID().replaceAll("-", "");
    const metadata: Checkpoint = {
      checkpointId,
      episodeId: record.episodeId,
      revision: record.revision,
      stateHash: hash,
      createdAt: new Date().toISOString(),
    };
    await this.snapshots.write(record.episodeId, checkpointId, snapshot);
    record.checkpoints.set(checkpointId, metadata);
    return metadata;
  }

  private assertLegalTrade(
    state: EngineRawState,
    proposal: TradeProposal,
  ): void {
    if (proposal.otherTeamId === state.userTeam.tid) {
      throw new DomainError(
        "ILLEGAL_ACTION",
        "Cannot trade with your own team",
      );
    }
    const ownedPids = new Set(state.roster.map((player) => player.pid));
    const ownedDpids = new Set(state.ownedPicks.map((pick) => pick.dpid));
    for (const asset of proposal.offered) {
      if (asset.type === "player" && !ownedPids.has(asset.pid)) {
        throw new DomainError(
          "ILLEGAL_ACTION",
          `Offered player ${asset.pid} is not on the user's roster`,
        );
      }
      if (asset.type === "draft_pick" && !ownedDpids.has(asset.dpid)) {
        throw new DomainError(
          "ILLEGAL_ACTION",
          `Offered draft pick ${asset.dpid} is not owned by the user`,
        );
      }
    }
  }

  /**
   * Reads raw state for an episode. An ended episode is served from the
   * cached snapshot taken right before its engine was closed, since the real
   * (worker-backed) engine can no longer answer after that; an active
   * episode always reads live, serialized through its queue.
   */
  private async readRawState(record: EpisodeRecord): Promise<EngineRawState> {
    if (record.status === "ended" && record.finalRawState) {
      return record.finalRawState;
    }
    return this.runQueued(record, () => record.engine.getRawState());
  }

  private evaluateConstraints(
    record: EpisodeRecord,
    state: EngineRawState,
  ): ConstraintStatus[] {
    const builtins = runBuiltinInvariants(state, record.startingSeason);
    const declared = evaluateScenarioConstraints(record.constraints, builtins);
    const extra = declared.filter(
      (status) => !builtins.some((builtin) => builtin.code === status.code),
    );
    return [...builtins, ...extra];
  }

  private computeStateHash(revision: number, state: EngineRawState): string {
    return stateHash({ revision, state });
  }

  private trajectoryRecord(
    record: EpisodeRecord,
    fields: Pick<
      TrajectoryRecord,
      | "step"
      | "toolName"
      | "args"
      | "preStateHash"
      | "postStateHash"
      | "normalizedAction"
      | "events"
      | "invariantResults"
      | "latencyMs"
    >,
  ): TrajectoryRecord {
    return {
      episodeId: record.episodeId,
      sequence: record.trajectorySequence++,
      timestamp: new Date().toISOString(),
      revision: record.revision,
      engine: record.engine.metadata,
      wrapperVersion: WRAPPER_VERSION,
      ...fields,
    };
  }

  /** Chains a task onto the episode's serialized queue; never lets a rejection break the chain for later tasks. */
  private runQueued<T>(
    record: EpisodeRecord,
    fn: () => Promise<T>,
  ): Promise<T> {
    const result = record.queue.then(fn);
    record.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runMutation(
    episodeId: string,
    context: MutationContext,
    spec: MutationSpec,
  ): Promise<MutationResult> {
    const record = this.episodes.getActive(episodeId);

    const cached = record.idempotency.get(context.idempotencyKey);
    if (cached) return cached;

    return this.runQueued(record, async () => {
      const alreadyApplied = record.idempotency.get(context.idempotencyKey);
      if (alreadyApplied) return alreadyApplied;

      const startedAt = Date.now();
      if (record.revision !== context.expectedRevision) {
        throw new DomainError(
          "REVISION_CONFLICT",
          "Episode revision is stale",
          {
            retryable: true,
            details: {
              expectedRevision: context.expectedRevision,
              currentRevision: record.revision,
            },
          },
        );
      }

      const beforeState = await record.engine.getRawState();
      const preStateHash = this.computeStateHash(record.revision, beforeState);

      if (spec.requiredPhase && beforeState.phase !== spec.requiredPhase) {
        throw new DomainError(
          "INVALID_PHASE",
          `${spec.toolName} requires phase ${spec.requiredPhase}, but the episode is in ${beforeState.phase}`,
        );
      }
      if (spec.disallowedPhases?.includes(beforeState.phase)) {
        throw new DomainError(
          "INVALID_PHASE",
          `${spec.toolName} is not allowed during phase ${beforeState.phase}`,
        );
      }
      spec.legality?.(beforeState, record);

      const rollbackSnapshot = await record.engine.exportSnapshot();
      const previousRevision = record.revision;

      try {
        const events = await spec.execute(record);
        const afterState = await record.engine.getRawState();
        const constraints = this.evaluateConstraints(record, afterState);
        if (hasHardFailure(constraints)) {
          throw new DomainError(
            "INVARIANT_VIOLATION",
            "Mutation violated one or more hard constraints and was rolled back",
            {
              details: {
                failedConstraints: constraints.filter(
                  (status) => status.kind === "hard" && !status.satisfied,
                ),
              },
            },
          );
        }

        record.revision += 1;
        const postStateHash = this.computeStateHash(
          record.revision,
          afterState,
        );
        const stateSummary = buildOverviewView(
          {
            episodeId,
            revision: record.revision,
            stateHash: postStateHash,
            state: afterState,
          },
          record.status,
          constraints,
        );
        const warnings = constraints
          .filter((status) => status.kind === "soft" && !status.satisfied)
          .map((status) => status.message);
        record.transactionEventCount += events.filter((event) =>
          TRANSACTION_EVENT_TYPES.has(event.type),
        ).length;

        const result: MutationResult = {
          episodeId,
          previousRevision,
          revision: record.revision,
          stateHash: postStateHash,
          appliedAction: spec.appliedAction,
          events,
          warnings,
          nextDecision: afterState.nextDecision,
          stateSummary,
        };
        record.idempotency.set(context.idempotencyKey, result);

        await record.trajectoryWriter.append(
          this.trajectoryRecord(record, {
            step: "mutation",
            toolName: spec.toolName,
            args: spec.args,
            preStateHash,
            postStateHash,
            normalizedAction: spec.appliedAction,
            events,
            invariantResults: constraints,
            latencyMs: Date.now() - startedAt,
          }),
        );

        return result;
      } catch (error) {
        if (
          error instanceof DomainError &&
          error.code === "INVARIANT_VIOLATION"
        ) {
          record.invariantViolationCount += 1;
        }
        record.revision = previousRevision;
        await record.engine.importSnapshot(rollbackSnapshot);
        logger.warn("mutation rolled back", {
          episodeId,
          toolName: spec.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }
}
