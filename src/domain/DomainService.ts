import { randomUUID } from "node:crypto";

import type * as z from "zod/v4";

import { createLogger } from "../logging/logger.js";
import type { AttemptRecord } from "../persistence/attemptLog.js";
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
  isBuiltinInvariantCode,
  runBuiltinInvariants,
} from "./invariants.js";
import {
  buildObjectivesFromSpec,
  buildOverviewView,
  buildView,
  isSupportedObjectiveCode,
} from "./normalization.js";
import {
  advanceInputSchema,
  advertiseOnTradingBlockInputSchema,
  createEpisodeInputSchema,
  endEpisodeInputSchema,
  getPlayerInputSchema,
  getStateInputSchema,
  makeDraftPickInputSchema,
  negotiateContractInputSchema,
  releasePlayerInputSchema,
  setLineupInputSchema,
  signFreeAgentInputSchema,
  tradeProposalSchema,
} from "./schemas.js";
import { stateHash } from "./stateHash.js";
import {
  DEFAULT_ALLOWED_ACTIONS,
  DEFAULT_ALLOWED_ADVANCE_TARGETS,
  DEFAULT_ALLOWED_INFORMATION,
} from "./types.js";
import type {
  AdvanceInput,
  AdvanceTarget,
  AdvertiseOnTradingBlockInput,
  Checkpoint,
  ConstraintStatus,
  EndEpisodeInput,
  EndEpisodeResult,
  EngineEvent,
  EngineRawState,
  GetPlayerResult,
  GetStateInput,
  LeagueStateView,
  MakeDraftPickInput,
  MutationContext,
  MutationResult,
  NegotiateContractInput,
  OptionsResult,
  OverviewView,
  Phase,
  PlayerSummary,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeEvaluation,
  TradeProposal,
  TradeProposalsData,
  TradingBlockData,
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
      scenarioPolicy: input.scenarioPolicy ?? {
        allowedInformation: [...DEFAULT_ALLOWED_INFORMATION],
        allowedActions: [...DEFAULT_ALLOWED_ACTIONS],
      },
      ...(input.initialSnapshot === undefined
        ? {}
        : {
            initialSnapshot: input.initialSnapshot,
            initialSnapshotHash: stateHash(input.initialSnapshot),
          }),
      // (ObjectiveDefinition.targetValue is `number | undefined` precisely so this zod-parsed
      // value is directly assignable under exactOptionalPropertyTypes -- see domain/types.ts)
    };
    const unsupportedHard = request.constraints.hard
      .filter((definition) => !isBuiltinInvariantCode(definition.code))
      .map((definition) => definition.code);
    if (unsupportedHard.length > 0) {
      throw new DomainError(
        "UNSUPPORTED_CONSTRAINT",
        "Scenario declares hard constraints without a registered evaluator",
        { details: { codes: unsupportedHard } },
      );
    }
    const unsupportedSoft = request.constraints.soft
      .filter((definition) => !isSupportedObjectiveCode(definition.code))
      .map((definition) => definition.code);
    if (unsupportedSoft.length > 0) {
      throw new DomainError(
        "UNSUPPORTED_OBJECTIVE",
        "Scenario declares soft objectives without a registered evaluator",
        { details: { codes: unsupportedSoft } },
      );
    }
    let record: EpisodeRecord | undefined;
    try {
      record = await this.episodes.create(request);
      const { initialSnapshot } = request;
      if (initialSnapshot !== undefined) {
        await this.runQueued(record, () =>
          record!.engine.importSnapshot(initialSnapshot),
        );
      }
      const state = await this.runQueued(record, () =>
        record!.engine.getRawState(),
      );
      const hash = this.computeStateHash(record.revision, state);
      const constraints = this.evaluateConstraints(record, state);
      const snapshot = await this.runQueued(record, () =>
        record!.engine.exportSnapshot(),
      );
      await this.snapshots.writeCurrent(record.episodeId, snapshot);
      record.lastStateHash = hash;

      const { initialSnapshot: _initialSnapshot, ...trajectoryArgs } = request;
      await record.trajectoryWriter.append(
        this.trajectoryRecord(record, {
          step: "create_episode",
          toolName: "bbgm_create_episode",
          args: trajectoryArgs,
          preStateHash: null,
          postStateHash: hash,
          normalizedAction: {
            type: "create_episode",
            scenarioId: request.scenarioId,
            seed: request.seed,
            ...(record.initialSnapshotHash === undefined
              ? {}
              : { initialSnapshotHash: record.initialSnapshotHash }),
          },
          events: [],
          invariantResults: constraints,
          latencyMs: 0,
        }),
      );
      await this.episodes.persist(record);
      await this.logAttempt(record, {
        operation: "bbgm_create_episode",
        kind: "lifecycle",
        outcome: "accepted",
        observedRevision: record.revision,
      });

      return buildOverviewView(
        {
          episodeId: record.episodeId,
          revision: record.revision,
          stateHash: hash,
          state,
        },
        record.status,
        constraints,
        record.scenarioPolicy.allowedActions,
        record.scenarioPolicy.allowedInformation,
      );
    } catch (error) {
      if (record) {
        await this.episodes.dispose(record.episodeId).catch((cleanupError) =>
          logger.error("failed to clean up episode initialization", {
            episodeId: record!.episodeId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          }),
        );
      }
      throw error;
    }
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
    let ended = false;
    try {
      const state = await this.runQueued(record, () =>
        record.engine.getRawState(),
      );
      const hash = this.computeStateHash(record.revision, state);

      let snapshotCheckpointId: string | undefined;
      if (input.exportFinalSnapshot) {
        const checkpoint = await this.createCheckpointFor(
          record,
          state,
          hash,
          true,
        );
        snapshotCheckpointId = checkpoint.checkpointId;
      }

      record.finalRawState = state;
      record.lastStateHash = hash;
      const finalSnapshot = await this.runQueued(record, () =>
        record.engine.exportSnapshot(),
      );
      await this.snapshots.writeCurrent(record.episodeId, finalSnapshot);
      const constraints = this.evaluateConstraints(record, state);
      record.status = "ended";
      ended = true;
      const finalState = buildOverviewView(
        {
          episodeId: record.episodeId,
          revision: record.revision,
          stateHash: hash,
          state,
        },
        record.status,
        constraints,
        record.scenarioPolicy.allowedActions,
        record.scenarioPolicy.allowedInformation,
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
      await this.episodes.persist(record);
      await this.logAttempt(record, {
        operation: "bbgm_end_episode",
        kind: "lifecycle",
        outcome: "accepted",
        observedRevision: record.revision,
      });

      return {
        episodeId,
        finalState,
        terminalMetrics: {
          episodeId,
          seasonsCompleted: Math.max(0, state.season - record.startingSeason),
          finalRecord: state.cumulativeRecord ?? {
            won: state.userTeam.won,
            lost: state.userTeam.lost,
          },
          hardConstraintViolations: record.invariantViolationCount,
          transactionCount: record.transactionEventCount,
        },
        ...(snapshotCheckpointId === undefined ? {} : { snapshotCheckpointId }),
      };
    } catch (error) {
      if (this.isWorkerFailure(error)) await this.quarantine(record, error);
      throw error;
    } finally {
      if (ended) await this.episodes.dispose(episodeId);
    }
  }

  async closeAll(): Promise<void> {
    await this.episodes.closeAll();
  }

  async resumeEpisode(episodeId: string): Promise<OverviewView> {
    const persisted = await this.episodes.readPersisted(episodeId);
    const existing = (() => {
      try {
        return this.episodes.get(episodeId);
      } catch {
        return undefined;
      }
    })();
    const record =
      existing ??
      (await this.episodes.resume(
        episodeId,
        await this.snapshots.readCurrent(episodeId),
      ));
    const wasQuarantined = record.status === "quarantined";
    if (wasQuarantined) record.status = "active";
    try {
      const state = await this.readRawState(record);
      const hash = this.computeStateHash(record.revision, state);
      if (persisted.stateHash !== undefined && persisted.stateHash !== hash) {
        throw new DomainError(
          "ENGINE_ERROR",
          "Persisted episode state does not match its recorded state hash",
          { details: { episodeId, revision: record.revision } },
        );
      }
      record.lastStateHash = hash;
      await this.episodes.persist(record);
      await this.logAttempt(record, {
        operation: "bbgm_resume_episode",
        kind: "lifecycle",
        outcome: "accepted",
        observedRevision: record.revision,
      });
      return buildOverviewView(
        {
          episodeId: record.episodeId,
          revision: record.revision,
          stateHash: hash,
          state,
        },
        record.status,
        this.evaluateConstraints(record, state),
        record.scenarioPolicy.allowedActions,
        record.scenarioPolicy.allowedInformation,
      );
    } catch (error) {
      if (wasQuarantined && record.status === "active") {
        record.status = "quarantined";
        await this.episodes.persist(record).catch((persistError) =>
          logger.error("failed to preserve quarantined episode status", {
            episodeId,
            error:
              persistError instanceof Error
                ? persistError.message
                : String(persistError),
          }),
        );
      }
      throw error;
    }
  }

  // -- reads -------------------------------------------------------------

  async getState(rawInput: unknown): Promise<LeagueStateView> {
    return this.readState(rawInput, true);
  }

  /** Unrestricted terminal observation for the evaluator, never exposed as an MCP tool. */
  async getStateForEvaluation(rawInput: unknown): Promise<LeagueStateView> {
    return this.readState(rawInput, false);
  }

  private async readState(
    rawInput: unknown,
    enforceInformationPolicy: boolean,
  ): Promise<LeagueStateView> {
    const input: GetStateInput = parse(getStateInputSchema, rawInput);
    const record = this.episodes.get(input.episodeId);
    if (enforceInformationPolicy) {
      this.assertInformationAllowed(record, input.view, "bbgm_get_state");
    }
    const state = await this.readRawState(record);
    const hash = this.computeStateHash(record.revision, state);
    const constraints = this.evaluateConstraints(record, state);
    const objectives = buildObjectivesFromSpec(record.constraints, state);

    let rosterOverride:
      { teamId: number; players: PlayerSummary[] } | undefined;
    if (
      input.view === "roster" &&
      input.teamId !== undefined &&
      input.teamId !== state.userTeam.tid
    ) {
      if (record.status !== "active") {
        throw new DomainError(
          "ILLEGAL_ACTION",
          "Another team's roster can only be read while the episode is active (the user's own final roster stays readable after end_episode, but other teams' live state does not)",
        );
      }
      const players = await this.runQueued(record, () =>
        record.engine.getTeamRoster(input.teamId!),
      );
      rosterOverride = { teamId: input.teamId, players };
    }

    let tradingBlockOverride: TradingBlockData | undefined;
    if (input.view === "trading_block") {
      tradingBlockOverride = await this.runQueued(record, () =>
        record.engine.getTradingBlock(),
      );
    }
    let tradeProposalsOverride: TradeProposalsData | undefined;
    if (input.view === "trade_proposals") {
      tradeProposalsOverride = await this.runQueued(record, () =>
        record.engine.getTradeProposals(),
      );
    }

    const result = buildView(
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
        allowedActions: record.scenarioPolicy.allowedActions,
        allowedInformation: record.scenarioPolicy.allowedInformation,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(rosterOverride ? { rosterOverride } : {}),
        ...(tradingBlockOverride ? { tradingBlockOverride } : {}),
        ...(tradeProposalsOverride ? { tradeProposalsOverride } : {}),
      },
    );
    await this.logAttempt(record, {
      operation: "bbgm_get_state",
      kind: "read",
      outcome: "accepted",
      ...(enforceInformationPolicy ? {} : { actor: "evaluator" as const }),
      observedRevision: record.revision,
      inputHash: stateHash({
        view: input.view,
        cursor: input.cursor,
        limit: input.limit,
        teamId: input.teamId,
      }),
    });
    return result;
  }

  async getOptions(
    episodeId: string,
    actor: AttemptRecord["actor"] = "agent",
  ): Promise<OptionsResult> {
    const record = this.episodes.getActive(episodeId);
    this.assertInformationAllowed(record, "options", "bbgm_get_options");
    try {
      const options = await this.runQueued(record, () =>
        record.engine.getOptions(),
      );
      const allowedAdvanceTargets =
        record.scenarioPolicy.allowedAdvanceTargets ??
        DEFAULT_ALLOWED_ADVANCE_TARGETS;
      const existingAdvanceTargets = new Set(
        options
          .filter((option) => option.type === "advance")
          .map((option) => option["target"])
          .filter((target): target is AdvanceTarget =>
            allowedAdvanceTargets.includes(target as AdvanceTarget),
          ),
      );
      const policyAdvanceOptions = allowedAdvanceTargets
        .filter((target) => !existingAdvanceTargets.has(target))
        .map((target) => ({
          type: "advance",
          target,
          ...(target === "days" || target === "games" ? { count: 1 } : {}),
        }));
      await this.logAttempt(record, {
        operation: "bbgm_get_options",
        kind: "read",
        actor,
        outcome: "accepted",
      });
      return {
        episodeId,
        revision: record.revision,
        options: [
          ...options.filter((option) => {
            if (!record.scenarioPolicy.allowedActions.includes(option.type))
              return false;
            if (option.type !== "advance") return true;
            return allowedAdvanceTargets.includes(
              option["target"] as AdvanceTarget,
            );
          }),
          ...(record.scenarioPolicy.allowedActions.includes("advance") &&
          record.scenarioPolicy.allowedAdvanceTargets !== undefined
            ? policyAdvanceOptions
            : []),
        ],
      };
    } catch (error) {
      if (this.isWorkerFailure(error)) await this.quarantine(record, error);
      await this.logAttempt(record, {
        operation: "bbgm_get_options",
        kind: "read",
        actor,
        outcome: "rejected",
        ...this.rejectedAttemptFields(error),
      });
      throw error;
    }
  }

  /**
   * Deep detail for a single player -- the "click into a player" view. Never
   * throws for an unknown pid; the engine returns a partial/empty
   * PlayerDetail instead (see adapter.ts's getPlayer()), so a bad pid comes
   * back as a normal (if mostly-empty) result rather than an error.
   */
  async getPlayer(
    rawInput: unknown,
    actor: AttemptRecord["actor"] = "agent",
  ): Promise<GetPlayerResult> {
    const input = parse(getPlayerInputSchema, rawInput);
    const record = this.episodes.getActive(input.episodeId);
    this.assertInformationAllowed(record, "player_detail", "bbgm_get_player");
    try {
      const player = await this.runQueued(record, () =>
        record.engine.getPlayer(input.pid),
      );
      await this.logAttempt(record, {
        operation: "bbgm_get_player",
        kind: "read",
        actor,
        outcome: "accepted",
        observedRevision: record.revision,
        inputHash: stateHash({ pid: input.pid }),
      });
      return { episodeId: input.episodeId, revision: record.revision, player };
    } catch (error) {
      if (this.isWorkerFailure(error)) await this.quarantine(record, error);
      await this.logAttempt(record, {
        operation: "bbgm_get_player",
        kind: "read",
        actor,
        outcome: "rejected",
        ...this.rejectedAttemptFields(error),
      });
      throw error;
    }
  }

  async evaluateTrade(
    episodeId: string,
    rawProposal: unknown,
  ): Promise<TradeEvaluation> {
    const proposal = parse(tradeProposalSchema, rawProposal);
    const record = this.episodes.getActive(episodeId);
    try {
      this.beginAction(record, "evaluate_trade");
      const result = await this.runQueued(record, () =>
        record.engine.evaluateTrade(proposal),
      );
      await this.logAttempt(record, {
        operation: "bbgm_evaluate_trade",
        kind: "read",
        outcome: "accepted",
        inputHash: stateHash(proposal),
      });
      return result;
    } catch (error) {
      if (this.isWorkerFailure(error)) await this.quarantine(record, error);
      await this.logAttempt(record, {
        operation: "bbgm_evaluate_trade",
        kind: "read",
        outcome: "rejected",
        ...this.rejectedAttemptFields(error),
        inputHash: stateHash(proposal),
      });
      throw error;
    }
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

  /**
   * Advertises roster players / owned picks on the trading block. A
   * MUTATION, not a read: it persists engine state (zengm's
   * idb.cache.savedTradingBlock) the same way every other action here does
   * -- optimistic expectedRevision check, durable idempotencyKey, and
   * rollback to the pre-action snapshot on a hard-constraint failure -- see
   * runMutation(). An empty pids/dpids pair clears the trading block.
   */
  async advertiseOnTradingBlock(
    episodeId: string,
    rawInput: unknown,
    context: MutationContext,
  ): Promise<MutationResult> {
    const input: AdvertiseOnTradingBlockInput = parse(
      advertiseOnTradingBlockInputSchema,
      rawInput,
    );
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_advertise_on_trading_block",
      appliedAction: {
        type: "advertise_on_trading_block",
        pids: input.pids,
        dpids: input.dpids,
      },
      args: { input },
      disallowedPhases: ["draft"],
      legality: (state) => {
        const rosterPlayers = new Map(
          state.roster.map((player) => [player.pid, player]),
        );
        for (const pid of input.pids) {
          const player = rosterPlayers.get(pid);
          if (!player) {
            throw new DomainError(
              "ILLEGAL_ACTION",
              `Player ${pid} is not on the user's roster`,
            );
          }
          if (player.untradable) {
            throw new DomainError(
              "ILLEGAL_ACTION",
              `Player ${pid} is untradable and cannot be advertised`,
            );
          }
        }
        const ownedDpids = new Set(state.ownedPicks.map((pick) => pick.dpid));
        for (const dpid of input.dpids) {
          if (!ownedDpids.has(dpid)) {
            throw new DomainError(
              "ILLEGAL_ACTION",
              `Draft pick ${dpid} is not owned by the user`,
            );
          }
        }
      },
      execute: (record) => record.engine.advertiseOnTradingBlock(input),
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
        const onRoster = state.roster.some(
          (player) => player.pid === input.pid,
        );
        const resigningFreeAgent =
          state.phase === "resigning" &&
          state.freeAgents.some((player) => player.pid === input.pid);
        if (!onRoster && !resigningFreeAgent) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Player ${input.pid} is not eligible for contract negotiation in the current phase`,
            {
              details: {
                pid: input.pid,
                phase: state.phase,
                onRoster,
                resigningFreeAgent,
              },
            },
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
      legality: (_state, record) => {
        const allowedTargets =
          record.scenarioPolicy.allowedAdvanceTargets ??
          DEFAULT_ALLOWED_ADVANCE_TARGETS;
        if (!allowedTargets.includes(input.target)) {
          throw new DomainError(
            "ACTION_NOT_ALLOWED",
            `Scenario does not allow advance target: ${input.target}`,
            {
              details: {
                target: input.target,
                allowedAdvanceTargets: allowedTargets,
              },
            },
          );
        }
      },
      execute: (record) => record.engine.advance(input),
    });
  }

  // -- checkpoints -----------------------------------------------------------

  async createCheckpoint(episodeId: string): Promise<Checkpoint> {
    const record = this.episodes.getActive(episodeId);
    try {
      this.beginAction(record, "create_checkpoint");
      const state = await this.runQueued(record, () =>
        record.engine.getRawState(),
      );
      const hash = this.computeStateHash(record.revision, state);
      const checkpoint = await this.createCheckpointFor(record, state, hash);
      await this.logAttempt(record, {
        operation: "bbgm_create_checkpoint",
        kind: "lifecycle",
        outcome: "accepted",
      });
      return checkpoint;
    } catch (error) {
      if (this.isWorkerFailure(error)) await this.quarantine(record, error);
      await this.logAttempt(record, {
        operation: "bbgm_create_checkpoint",
        kind: "lifecycle",
        outcome: "rejected",
        ...this.rejectedAttemptFields(error),
      });
      throw error;
    }
  }

  listCheckpoints(episodeId: string): Checkpoint[] {
    const record = this.episodes.get(episodeId);
    try {
      this.beginAction(record, "list_checkpoints");
    } catch (error) {
      void this.logAttempt(record, {
        operation: "bbgm_list_checkpoints",
        kind: "read",
        outcome: "rejected",
        ...this.rejectedAttemptFields(error),
      });
      throw error;
    }
    void this.logAttempt(record, {
      operation: "bbgm_list_checkpoints",
      kind: "read",
      outcome: "accepted",
    });
    return [...record.checkpoints.values()];
  }

  async restoreCheckpoint(
    episodeId: string,
    checkpointId: string,
    context: MutationContext,
  ): Promise<MutationResult> {
    return this.runMutation(episodeId, context, {
      toolName: "bbgm_restore_checkpoint",
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
    final = false,
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
    if (final) {
      await this.snapshots.writeFinal(record.episodeId, snapshot);
    }
    record.checkpoints.set(checkpointId, metadata);
    const checkpointHash = this.computeStateHash(record.revision, state);
    await record.trajectoryWriter.append(
      this.trajectoryRecord(record, {
        step: "checkpoint",
        toolName: "bbgm_create_checkpoint",
        args: { episodeId: record.episodeId, checkpointId },
        preStateHash: checkpointHash,
        postStateHash: checkpointHash,
        normalizedAction: { type: "create_checkpoint", checkpointId },
        events: [{ type: "checkpoint_created", checkpointId }],
        invariantResults: this.evaluateConstraints(record, state),
        latencyMs: 0,
      }),
    );
    await this.episodes.persist(record);
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
    const offeredKeys = new Set<string>();
    const requestedKeys = new Set<string>();
    for (const [side, assets, keys] of [
      ["offered", proposal.offered, offeredKeys],
      ["requested", proposal.requested, requestedKeys],
    ] as const) {
      for (const asset of assets) {
        const key =
          asset.type === "player"
            ? `player:${asset.pid}`
            : `pick:${asset.dpid}`;
        if (keys.has(key)) {
          throw new DomainError(
            "ILLEGAL_ACTION",
            `Trade ${side} contains duplicate asset ${key}`,
          );
        }
        keys.add(key);
      }
    }
    for (const key of offeredKeys) {
      if (requestedKeys.has(key)) {
        throw new DomainError(
          "ILLEGAL_ACTION",
          `Trade cannot offer and request the same asset ${key}`,
        );
      }
    }
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
    if (record.status === "quarantined") {
      throw new DomainError(
        "ENGINE_ERROR",
        "Episode is quarantined after an engine failure; resume it before reading live state",
      );
    }
    try {
      return await this.runQueued(record, () => record.engine.getRawState());
    } catch (error) {
      await this.quarantine(record, error);
      throw error;
    }
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

  private assertInformationAllowed(
    record: EpisodeRecord,
    information: string,
    operation: string,
  ): void {
    if (!record.scenarioPolicy.allowedInformation.includes(information)) {
      const error = new DomainError(
        "INFORMATION_NOT_ALLOWED",
        `Scenario does not allow access to information channel: ${information}`,
        {
          details: {
            information,
            allowedInformation: record.scenarioPolicy.allowedInformation,
          },
        },
      );
      void this.logAttempt(record, {
        operation,
        kind: "read",
        outcome: "rejected",
        outcomeCode: error.code,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      throw error;
    }
  }

  private beginAction(record: EpisodeRecord, action: string): void {
    if (!record.scenarioPolicy.allowedActions.includes(action)) {
      throw new DomainError(
        "ACTION_NOT_ALLOWED",
        `Scenario does not allow action: ${action}`,
        {
          details: {
            action,
            allowedActions: record.scenarioPolicy.allowedActions,
          },
        },
      );
    }
    const maxSteps = record.scenarioPolicy.maxSteps;
    if (maxSteps !== undefined && record.stepCount >= maxSteps) {
      throw new DomainError(
        "STEP_LIMIT",
        `Scenario step limit of ${maxSteps} has been reached`,
        { details: { maxSteps, stepsTaken: record.stepCount } },
      );
    }
    record.stepCount += 1;
  }

  private assertHorizon(record: EpisodeRecord, season: number): void {
    const horizonSeasons = record.scenarioPolicy.horizonSeasons;
    if (
      horizonSeasons !== undefined &&
      season >= record.startingSeason + horizonSeasons
    ) {
      throw new DomainError(
        "HORIZON_REACHED",
        `Scenario horizon of ${horizonSeasons} season(s) has been reached`,
        {
          details: {
            startingSeason: record.startingSeason,
            currentSeason: season,
            horizonSeasons,
          },
        },
      );
    }
  }

  private computeStateHash(revision: number, state: EngineRawState): string {
    return stateHash({ revision, state });
  }

  private errorCode(error: unknown): string {
    const code =
      error instanceof Error
        ? (error as Error & { code?: unknown }).code
        : null;
    return typeof code === "string" ? code : "ENGINE_ERROR";
  }

  private errorDetails(error: unknown): Record<string, unknown> | undefined {
    if (!(error instanceof Error)) return undefined;
    const details = (error as Error & { details?: unknown }).details;
    if (
      typeof details !== "object" ||
      details === null ||
      Array.isArray(details)
    ) {
      return undefined;
    }
    return details as Record<string, unknown>;
  }

  private rejectedAttemptFields(
    error: unknown,
  ): Pick<AttemptRecord, "outcomeCode" | "retryable" | "details"> {
    const details = this.errorDetails(error);
    return {
      outcomeCode: this.errorCode(error),
      retryable: this.retryable(error),
      ...(details === undefined ? {} : { details }),
    };
  }

  private retryable(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error as Error & { retryable?: unknown }).retryable === true
    );
  }

  private rollbackRequired(error: unknown): boolean {
    return (
      (error as Error & { rollbackRequired?: unknown }).rollbackRequired !==
      false
    );
  }

  private isWorkerFailure(error: unknown): boolean {
    const code =
      error instanceof Error
        ? (error as Error & { code?: unknown }).code
        : null;
    return code === "TIMEOUT" || code === "ENGINE_ERROR";
  }

  private async quarantine(
    record: EpisodeRecord,
    error: unknown,
  ): Promise<void> {
    if (record.status === "active") record.status = "quarantined";
    try {
      await this.episodes.persist(record);
    } catch (persistError) {
      logger.error("failed to persist quarantined episode", {
        episodeId: record.episodeId,
        error:
          persistError instanceof Error
            ? persistError.message
            : String(persistError),
      });
    }
    logger.error("episode quarantined after engine failure", {
      episodeId: record.episodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async logAttempt(
    record: EpisodeRecord,
    fields: Omit<AttemptRecord, "episodeId" | "sequence" | "timestamp">,
  ): Promise<void> {
    const attempt: AttemptRecord = {
      episodeId: record.episodeId,
      sequence: record.attemptSequence++,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    try {
      await record.attemptWriter.append(attempt);
      await this.episodes.persist(record);
    } catch (error) {
      logger.error("failed to persist behavioral audit record", {
        episodeId: record.episodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    const fingerprint = this.mutationFingerprint(
      episodeId,
      context.expectedRevision,
      spec,
    );

    try {
      const cached = record.idempotency.get(context.idempotencyKey);
      if (cached) {
        const replayed = this.replayOrRejectIdempotency(cached, fingerprint);
        await this.logAttempt(record, {
          operation: spec.toolName,
          kind: "mutation",
          outcome: "idempotent_replay",
          expectedRevision: context.expectedRevision,
          observedRevision: record.revision,
          idempotencyKey: context.idempotencyKey,
          inputHash: fingerprint,
        });
        return replayed;
      }

      const result = await this.runQueued(record, async () => {
        const alreadyApplied = record.idempotency.get(context.idempotencyKey);
        if (alreadyApplied)
          return this.replayOrRejectIdempotency(alreadyApplied, fingerprint);
        // A replay is not a new action attempt. Check the durable idempotency
        // record before enforcing budgets so concurrent retries remain safe
        // even when the first request consumed the final permitted step.
        this.beginAction(record, spec.toolName.replace(/^bbgm_/, ""));

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
        this.assertHorizon(record, beforeState.season);
        const preStateHash = this.computeStateHash(
          record.revision,
          beforeState,
        );

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
        const previousStateHash = record.lastStateHash;
        const previousTrajectorySequence = record.trajectorySequence;
        const previousTransactionEventCount = record.transactionEventCount;
        let acceptedTrajectoryAppended = false;
        let rejectionInvariantResults: ConstraintStatus[] = [];

        try {
          const events = await spec.execute(record);
          const afterState = await record.engine.getRawState();
          const constraints = this.evaluateConstraints(record, afterState);
          if (hasHardFailure(constraints)) {
            rejectionInvariantResults = constraints;
            const failed = constraints.filter(
              (status) => status.kind === "hard" && !status.satisfied,
            );
            // Name the violated constraints in the message itself. An agent
            // only sees the message string, and a generic one gives it no way
            // to connect the failure to a legal remedy.
            throw new DomainError(
              "INVARIANT_VIOLATION",
              `Mutation violated hard constraints and was rolled back: ${failed
                .map((status) => `${status.code} (${status.message})`)
                .join("; ")}`,
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
            record.scenarioPolicy.allowedActions,
            record.scenarioPolicy.allowedInformation,
          );
          const warnings = constraints
            .filter((status) => status.kind === "soft" && !status.satisfied)
            .map((status) => status.message);
          record.transactionEventCount += events.filter((event) =>
            TRANSACTION_EVENT_TYPES.has(event.type),
          ).length;
          const postSnapshot = await record.engine.exportSnapshot();
          await this.snapshots.writeCurrent(record.episodeId, postSnapshot);
          record.lastStateHash = postStateHash;

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
          record.idempotency.set(context.idempotencyKey, {
            fingerprint,
            result,
          });

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
          acceptedTrajectoryAppended = true;
          await this.episodes.persist(record);

          return result;
        } catch (error) {
          if (
            error instanceof DomainError &&
            error.code === "INVARIANT_VIOLATION"
          ) {
            record.invariantViolationCount += 1;
          }
          record.revision = previousRevision;
          record.transactionEventCount = previousTransactionEventCount;
          record.trajectorySequence = previousTrajectorySequence;
          if (previousStateHash === undefined) {
            delete record.lastStateHash;
          } else {
            record.lastStateHash = previousStateHash;
          }
          record.idempotency.delete(context.idempotencyKey);
          if (acceptedTrajectoryAppended) {
            const integrityError = new DomainError(
              "ENGINE_ERROR",
              "Mutation was recorded but its metadata commit failed; episode quarantined",
              {
                details: {
                  originalError:
                    error instanceof Error ? error.message : String(error),
                },
              },
            );
            await this.quarantine(record, integrityError);
            throw integrityError;
          }

          const rollbackRequired = this.rollbackRequired(error);
          if (rollbackRequired) {
            try {
              await record.engine.importSnapshot(rollbackSnapshot);
              await this.snapshots.writeCurrent(
                record.episodeId,
                rollbackSnapshot,
              );
            } catch (rollbackError) {
              const integrityError = new DomainError(
                "ENGINE_ERROR",
                "Rollback failed while restoring the pre-action snapshot; episode quarantined",
                {
                  details: {
                    originalError:
                      error instanceof Error ? error.message : String(error),
                    rollbackError:
                      rollbackError instanceof Error
                        ? rollbackError.message
                        : String(rollbackError),
                  },
                },
              );
              await this.quarantine(record, integrityError);
              throw integrityError;
            }
          }
          const restoredState = await record.engine.getRawState();
          const restoredStateHash = this.computeStateHash(
            previousRevision,
            restoredState,
          );
          if (restoredStateHash !== preStateHash) {
            const integrityError = new DomainError(
              "ENGINE_ERROR",
              "Rollback did not restore the pre-action state hash; episode quarantined",
              {
                details: {
                  expectedStateHash: preStateHash,
                  restoredStateHash,
                  revision: previousRevision,
                  originalError:
                    error instanceof Error ? error.message : String(error),
                },
              },
            );
            await this.quarantine(record, integrityError);
            throw integrityError;
          }
          record.lastStateHash = restoredStateHash;
          const rollbackRecord = this.trajectoryRecord(record, {
            step: "rollback",
            toolName: spec.toolName,
            args: spec.args,
            preStateHash,
            postStateHash: restoredStateHash,
            normalizedAction: spec.appliedAction,
            events: [
              {
                type: "rollback",
                outcomeCode: this.errorCode(error),
                rollbackRequired,
                restoredStateHash,
              },
            ],
            invariantResults: rejectionInvariantResults,
            latencyMs: Date.now() - startedAt,
          });
          rollbackRecord.rollback = {
            outcomeCode: this.errorCode(error),
            rollbackRequired,
            restoredStateHash,
          };
          await record.trajectoryWriter.append(rollbackRecord);
          await this.episodes.persist(record);
          logger.warn("mutation rolled back", {
            episodeId,
            toolName: spec.toolName,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });
      await this.logAttempt(record, {
        operation: spec.toolName,
        kind: "mutation",
        outcome: "accepted",
        expectedRevision: context.expectedRevision,
        observedRevision: result.revision,
        idempotencyKey: context.idempotencyKey,
        inputHash: fingerprint,
      });
      return result;
    } catch (error) {
      if (this.isWorkerFailure(error)) await this.quarantine(record, error);
      await this.logAttempt(record, {
        operation: spec.toolName,
        kind: "mutation",
        outcome: "rejected",
        ...this.rejectedAttemptFields(error),
        expectedRevision: context.expectedRevision,
        observedRevision: record.revision,
        idempotencyKey: context.idempotencyKey,
        inputHash: fingerprint,
      });
      throw error;
    }
  }

  private mutationFingerprint(
    episodeId: string,
    expectedRevision: number,
    spec: MutationSpec,
  ): string {
    return stateHash({
      episodeId,
      expectedRevision,
      toolName: spec.toolName,
      appliedAction: spec.appliedAction,
    });
  }

  private replayOrRejectIdempotency(
    cached: { fingerprint: string; result: MutationResult },
    fingerprint: string,
  ): MutationResult {
    if (cached.fingerprint !== fingerprint) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotencyKey was already used for a different mutation",
        {
          details: {
            originalResultRevision: cached.result.revision,
          },
        },
      );
    }
    return cached.result;
  }
}
