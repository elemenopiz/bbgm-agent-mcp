import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { DomainService } from "../../src/domain/DomainService.js";
import { GET_STATE_VIEWS } from "../../src/domain/types.js";
import type {
  Checkpoint,
  LeagueStateView,
  MutationResult,
  OptionsResult,
  OverviewView,
  TradeEvaluation,
} from "../../src/domain/types.js";
import {
  boundedObservationSchema,
  externalActionSchema,
  type ActionEnvelope,
  type AuditSink,
  type BoundedObservation,
  type ExternalAction,
  type FailureRecord,
  type ModelCallback,
  type StepRecord,
  type ToolResultRecord,
} from "./types.js";

const failureFrom = (
  stage: FailureRecord["stage"],
  error: unknown,
): FailureRecord => ({
  stage,
  code:
    error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code)
      : stage === "callback"
        ? "MODEL_CALLBACK_ERROR"
        : stage === "observation"
          ? "OBSERVATION_ERROR"
          : stage === "parse"
            ? "ACTION_PARSE_ERROR"
            : stage === "policy"
              ? "ACTION_NOT_ALLOWED"
              : "TOOL_ERROR",
  message:
    stage === "callback"
      ? "External model callback failed"
      : stage === "observation"
        ? "Policy observation could not be constructed"
        : stage === "parse"
          ? "Model output was not exactly one valid action"
          : stage === "policy"
            ? error instanceof Error
              ? error.message
              : "Model action is not permitted by the scenario policy"
            : error instanceof Error
              ? error.message
              : "External action failed",
  retryable:
    error instanceof Error && "retryable" in error
      ? Boolean((error as Error & { retryable?: unknown }).retryable)
      : false,
});

const boundedViewNames = new Set<string>(GET_STATE_VIEWS);

const boundedObservationView = (view: LeagueStateView): LeagueStateView => {
  if (!boundedViewNames.has(view.view)) {
    throw new Error(`Unsupported observation view: ${view.view}`);
  }
  return view;
};

const observationFrom = async (
  domain: DomainService,
  overview: OverviewView,
  allowedInformation: readonly string[],
  allowedActions: readonly string[],
): Promise<BoundedObservation> => {
  if (!allowedInformation.includes("overview")) {
    throw new Error(
      "External policy observations require the overview information channel",
    );
  }

  const views: Record<string, LeagueStateView> = {
    overview: boundedObservationView(overview),
  };
  for (const view of GET_STATE_VIEWS) {
    if (view === "overview" || !allowedInformation.includes(view)) continue;
    views[view] = boundedObservationView(
      await domain.getState({
        episodeId: overview.episodeId,
        view,
        limit: 50,
      }),
    );
  }

  const options = allowedInformation.includes("options")
    ? (await domain.getOptions(overview.episodeId)).options.slice(0, 50)
    : undefined;

  return boundedObservationSchema.parse({
    schemaVersion: "external-policy-observation.v2",
    episodeId: overview.episodeId,
    revision: overview.revision,
    stateHash: overview.stateHash,
    season: overview.season,
    phase: overview.phase,
    nextDecision: overview.nextDecision.slice(0, 256),
    legalActionCategories: overview.legalActionCategories
      .slice(0, 16)
      .map((category) => category.slice(0, 64)),
    rosterCount: overview.rosterCount,
    ownedPickCount: overview.ownedPickCount,
    constraintsSatisfied: overview.constraintsSatisfied,
    allowedInformation: [...allowedInformation],
    allowedActions: [...allowedActions],
    views,
    ...(options === undefined ? {} : { options }),
  });
};

type ExternalPolicyPolicy = {
  allowedInformation: readonly string[];
  allowedActions: readonly string[];
  maxSteps?: number;
};

type ExternalToolValue =
  | Checkpoint
  | Checkpoint[]
  | LeagueStateView
  | MutationResult
  | OptionsResult
  | TradeEvaluation;

const MUTATING_TOOLS = new Set([
  "bbgm_execute_trade",
  "bbgm_set_lineup",
  "bbgm_release_player",
  "bbgm_negotiate_contract",
  "bbgm_sign_free_agent",
  "bbgm_make_draft_pick",
  "bbgm_advance",
  "bbgm_restore_checkpoint",
]);

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {}

  async append(record: StepRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export class ExternalPolicyRunner {
  private inFlight = false;
  private sequence = 0;
  private lastObservation: BoundedObservation | null = null;
  private readonly allowedInformation: readonly string[];
  private readonly allowedActions: readonly string[];

  constructor(
    private readonly domain: DomainService,
    private readonly episodeId: string,
    private readonly callback: ModelCallback,
    private readonly audit: AuditSink,
    private readonly idempotencyPrefix: string,
    policy: ExternalPolicyPolicy,
  ) {
    this.allowedInformation = [...policy.allowedInformation];
    this.allowedActions = [...policy.allowedActions];
    this.maxSteps = policy.maxSteps ?? 5000;
  }

  private readonly maxSteps: number;

  async run(stepCount: number): Promise<StepRecord[]> {
    if (
      !Number.isInteger(stepCount) ||
      stepCount < 1 ||
      stepCount > this.maxSteps
    ) {
      throw new Error(
        `stepCount must be an integer from 1 through ${this.maxSteps}`,
      );
    }

    const records: StepRecord[] = [];
    for (let index = 0; index < stepCount; index += 1) {
      records.push(await this.step());
    }
    return records;
  }

  private async observe(): Promise<BoundedObservation> {
    const overview = await this.domain.getState({
      episodeId: this.episodeId,
      view: "overview",
    });
    if (overview.view !== "overview") {
      throw new Error("Expected overview observation");
    }
    return observationFrom(
      this.domain,
      overview,
      this.allowedInformation,
      this.allowedActions,
    );
  }

  private async step(): Promise<StepRecord> {
    if (this.inFlight) {
      throw new Error("Only one external action envelope may be in flight");
    }
    this.inFlight = true;
    const idempotencyKey = `${this.idempotencyPrefix}-${String(
      this.sequence + 1,
    ).padStart(4, "0")}`;
    const base: StepRecord = {
      schemaVersion: "external-policy-step.v1",
      sequence: this.sequence + 1,
      observedAt: new Date().toISOString(),
      observation: this.lastObservation,
      rawModelOutput: null,
      parsedAction: null,
      actionEnvelope: null,
      toolResult: null,
      revision: { before: this.lastObservation?.revision ?? null, after: null },
      idempotency: { key: idempotencyKey, status: "issued" },
      failure: null,
    };

    try {
      let observation: BoundedObservation | undefined;
      try {
        observation = await this.observe();
        base.observation = observation;
        base.revision.before = observation.revision;
        this.lastObservation = observation;
      } catch (error) {
        base.failure = failureFrom("observation", error);
        base.idempotency.status = "not_applicable";
        await this.persist(base);
        throw error;
      }

      let rawModelOutput: unknown;
      try {
        rawModelOutput = await this.callback(observation);
        base.rawModelOutput = rawModelOutput;
      } catch (error) {
        base.failure = failureFrom("callback", error);
        base.idempotency.status = "not_applied";
        await this.persist(base);
        throw error;
      }

      const parsed = externalActionSchema.safeParse(rawModelOutput);
      if (!parsed.success) {
        base.failure = failureFrom("parse", parsed.error);
        base.idempotency.status = "not_applied";
        await this.persist(base);
        throw new Error(base.failure.message);
      }

      try {
        this.assertActionAllowed(parsed.data);
      } catch (error) {
        base.failure = failureFrom("policy", error);
        base.idempotency.status = "not_applicable";
        await this.persist(base);
        throw error;
      }

      const envelope: ActionEnvelope = {
        episodeId: this.episodeId,
        expectedRevision: observation.revision,
        idempotencyKey,
        action: parsed.data,
      };
      base.parsedAction = parsed.data;
      base.actionEnvelope = envelope;
      if (!MUTATING_TOOLS.has(parsed.data.toolName)) {
        base.idempotency.status = "not_applicable";
      }

      try {
        const value = await this.invoke(envelope);
        const toolResult: ToolResultRecord = { status: "ok", value };
        base.toolResult = toolResult;
        if ("revision" in value) {
          base.revision.after = value.revision;
        }
        if (MUTATING_TOOLS.has(parsed.data.toolName)) {
          base.idempotency.status = "applied";
        }
      } catch (error) {
        const failure = failureFrom("tool", error);
        base.failure = failure;
        base.toolResult = { status: "error", failure };
        base.idempotency.status = MUTATING_TOOLS.has(parsed.data.toolName)
          ? "not_applied"
          : "not_applicable";
      }

      await this.persist(base);
      if (base.failure !== null) {
        throw new Error(base.failure.message);
      }
      return base;
    } finally {
      this.sequence += 1;
      this.inFlight = false;
    }
  }

  private async invoke(envelope: ActionEnvelope): Promise<ExternalToolValue> {
    const context = {
      expectedRevision: envelope.expectedRevision,
      idempotencyKey: envelope.idempotencyKey,
    };

    switch (envelope.action.toolName) {
      case "bbgm_get_state":
        return this.domain.getState({
          episodeId: envelope.episodeId,
          ...envelope.action.arguments,
        });
      case "bbgm_get_options":
        return this.domain.getOptions(envelope.episodeId);
      case "bbgm_evaluate_trade":
        return this.domain.evaluateTrade(
          envelope.episodeId,
          envelope.action.arguments,
        );
      case "bbgm_execute_trade":
        return this.domain.executeTrade(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_set_lineup":
        return this.domain.setLineup(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_release_player":
        return this.domain.releasePlayer(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_negotiate_contract":
        return this.domain.negotiateContract(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_sign_free_agent":
        return this.domain.signFreeAgent(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_make_draft_pick":
        return this.domain.makeDraftPick(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_advance":
        return this.domain.advance(
          envelope.episodeId,
          envelope.action.arguments,
          context,
        );
      case "bbgm_create_checkpoint":
        return this.domain.createCheckpoint(envelope.episodeId);
      case "bbgm_list_checkpoints":
        return this.domain.listCheckpoints(envelope.episodeId);
      case "bbgm_restore_checkpoint":
        return this.domain.restoreCheckpoint(
          envelope.episodeId,
          envelope.action.arguments.checkpointId,
          context,
        );
    }
  }

  private assertActionAllowed(action: ExternalAction): void {
    if (action.toolName === "bbgm_get_state") {
      if (!this.allowedInformation.includes(action.arguments.view)) {
        throw new Error(
          `Scenario does not allow information channel: ${action.arguments.view}`,
        );
      }
      return;
    }
    if (action.toolName === "bbgm_get_options") {
      if (!this.allowedInformation.includes("options")) {
        throw new Error("Scenario does not allow information channel: options");
      }
      return;
    }
    const category = action.toolName.replace(/^bbgm_/, "");
    if (!this.allowedActions.includes(category)) {
      throw new Error(`Scenario does not allow action: ${category}`);
    }
  }

  private async persist(record: StepRecord): Promise<void> {
    try {
      await this.audit.append(record);
    } catch (error) {
      record.failure = failureFrom("audit", error);
      throw error;
    }
  }
}
