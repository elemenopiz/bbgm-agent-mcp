/**
 * A real OpenAI-compatible policy adapter for Tinker samplers and local
 * open-weight model servers.
 *
 * Tinker mode is selected by setting TINKER_BASE_URL, TINKER_MODEL, and
 * TINKER_API_KEY. Local mode uses BBGM_MODEL_BASE_URL (defaulting to
 * http://127.0.0.1:8000/v1) and does not require authentication. The same
 * typed action application path is used in both modes.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  externalActionSchema,
  type ExternalAction,
} from "../external-policy/types.js";
import type {
  AgentObservation,
  PolicyAdapter,
  PolicyName,
  PolicyStepContext,
  PolicyTelemetry,
} from "../../src/research/evaluate.js";

const DEFAULT_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct";
const DEFAULT_MODEL_REVISION = "12fd25f77366fa6b3b4b768ec3050bf629380bac";
const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const PROMPT_VERSION = "system-prompt-v2";
const promptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../external-policy/prompts/system-prompt-v2.md",
);
const promptText = readFileSync(promptPath, "utf8");
const promptSha256 = createHash("sha256")
  .update(promptText, "utf8")
  .digest("hex");

type ChatCompletionResponse = {
  choices?: {
    message?: { content?: unknown };
    text?: unknown;
  }[];
  model?: unknown;
};

type AdapterFactoryInput = { policyName: PolicyName; seed: string };

type ModelFailureKind = "provider" | "model";

class ModelFailure extends Error {
  constructor(
    public readonly failureKind: ModelFailureKind,
    message: string,
    /** Whether another attempt could plausibly succeed, and how long the
     * provider asked us to wait. Carried on the error rather than in module
     * state so concurrent seeds cannot clobber each other. */
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelFailure";
  }
}

type StructuredToolOutcome =
  | {
      status: "ok";
      toolName: ExternalAction["toolName"];
      result: unknown;
    }
  | {
      status: "error";
      toolName: ExternalAction["toolName"] | null;
      failure: {
        stage: "parse" | "tool";
        code: string;
        message: string;
        retryable: true;
      };
    };

type AppliedActionResult = {
  revision: number;
  result: unknown;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorDetails = (error: unknown): { name: string; message: string } => ({
  name: error instanceof Error ? error.name : "UnknownError",
  message: errorMessage(error),
});

const failedToolOutcome = (
  toolName: ExternalAction["toolName"] | null,
  stage: "parse" | "tool",
  error: unknown,
): StructuredToolOutcome => ({
  status: "error",
  toolName,
  failure: {
    stage,
    code: stage === "parse" ? "MODEL_ACTION_PARSE_ERROR" : "TOOL_ERROR",
    message: errorMessage(error),
    retryable: true,
  },
});

const modelBaseUrl = (): string =>
  (
    process.env["TINKER_BASE_URL"] ??
    process.env["BBGM_MODEL_BASE_URL"] ??
    DEFAULT_BASE_URL
  ).replace(/\/$/u, "");

const modelId = (): string =>
  process.env["TINKER_MODEL"] ?? process.env["BBGM_MODEL_ID"] ?? DEFAULT_MODEL;

const modelRevision = (): string | undefined =>
  process.env["TINKER_MODEL_REVISION"] ??
  process.env["BBGM_MODEL_REVISION"] ??
  (modelId() === DEFAULT_MODEL ? DEFAULT_MODEL_REVISION : undefined);

const requiredPolicy = (policyName: PolicyName): void => {
  if (policyName !== "untrained_open_model") {
    throw new Error(
      `This adapter is registered for untrained_open_model, not ${policyName}`,
    );
  }
};

const contentText = (response: ChatCompletionResponse): string => {
  const content =
    response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  throw new Error("model response did not contain text content");
};

const parseAction = (value: string): ExternalAction => {
  const trimmed = value.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return externalActionSchema.parse(JSON.parse(candidate) as unknown);
    } catch {
      // Keep trying the bounded extraction forms before reporting one parse
      // failure. The raw output is retained in the model trace.
    }
  }
  throw new Error("model output was not exactly one valid typed JSON action");
};

const contextFor = (context: PolicyStepContext, suffix = "action") => ({
  expectedRevision: context.revision,
  idempotencyKey: `model-${context.seed}-${context.stepNumber}-${suffix}`.slice(
    0,
    80,
  ),
});

const applyAction = async (
  context: PolicyStepContext,
  action: ExternalAction,
): Promise<AppliedActionResult> => {
  const { environment } = context;
  switch (action.toolName) {
    case "bbgm_get_state":
      return {
        revision: context.revision,
        result: await environment.getState(action.arguments),
      };
    case "bbgm_get_options":
      return {
        revision: context.revision,
        result: await environment.getOptions(),
      };
    case "bbgm_evaluate_trade":
      return {
        revision: context.revision,
        result: await environment.evaluateTrade(action.arguments),
      };
    case "bbgm_execute_trade": {
      const result = await environment.executeTrade(
        action.arguments,
        contextFor(context, "trade"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_set_lineup": {
      const result = await environment.setLineup(
        action.arguments,
        contextFor(context, "lineup"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_release_player": {
      const result = await environment.releasePlayer(
        action.arguments,
        contextFor(context, "release"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_negotiate_contract": {
      const result = await environment.negotiateContract(
        action.arguments,
        contextFor(context, "contract"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_sign_free_agent": {
      const result = await environment.signFreeAgent(
        action.arguments,
        contextFor(context, "free-agent"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_make_draft_pick": {
      const result = await environment.makeDraftPick(
        action.arguments,
        contextFor(context, "draft"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_advance": {
      const result = await environment.advance(
        action.arguments,
        contextFor(context, "advance"),
      );
      return { revision: result.revision, result };
    }
    case "bbgm_create_checkpoint":
      return {
        revision: context.revision,
        result: await environment.createCheckpoint(),
      };
    case "bbgm_list_checkpoints":
      return {
        revision: context.revision,
        result: environment.listCheckpoints(),
      };
    case "bbgm_restore_checkpoint": {
      const result = await environment.restoreCheckpoint(
        action.arguments.checkpointId,
        contextFor(context, "restore"),
      );
      return { revision: result.revision, result };
    }
  }
};

const compactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        compactValue(item, depth + 1),
      ]),
    );
  }
  return value;
};

const compactObservation = (observation: AgentObservation): unknown =>
  compactValue(observation);

const observationPrompt = (
  observation: AgentObservation,
  lastToolOutcome: StructuredToolOutcome | null,
): string =>
  `${promptText}\n\nObservation JSON:\n${JSON.stringify(compactObservation(observation))}\n\nLast tool result/error JSON:\n${JSON.stringify(compactValue(lastToolOutcome))}\n\nReturn one action JSON object:`;

/**
 * Retry budget for transient provider failures. A shared free-tier endpoint
 * returns 429 routinely, and treating that as fatal ends the episode at
 * whatever step the limiter happened to fire -- which shows up in the report
 * as a stalled policy rather than as a busy provider. Retrying bounded and
 * backing off keeps provider capacity out of the behavioural measurement.
 * Genuine model failures (unparseable output, a refused request) are not
 * retried; only transport errors, 429, and 5xx are.
 */
const RETRY_ATTEMPTS = Number(process.env["BBGM_MODEL_RETRY_ATTEMPTS"] ?? 6);
const RETRY_BASE_MS = Number(process.env["BBGM_MODEL_RETRY_BASE_MS"] ?? 2000);

/**
 * Optional comma-separated fallback models, tried in order when the primary
 * model is unavailable (a shared free tier rate-limits per model, so a second
 * model is usually servable when the first is not).
 *
 * This trades policy identity for completion, so it is off unless explicitly
 * set. A run that used it is NOT a single-policy result: every response
 * records its serving model, and any comparison across policies must pin one
 * model instead. Use it to exercise the environment, never to produce a
 * behavioural measurement.
 */
const fallbackModels = (): string[] =>
  (process.env["BBGM_MODEL_FALLBACK_IDS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status === 408 || status >= 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const callModel = async (
  context: PolicyStepContext,
  lastToolOutcome: StructuredToolOutcome | null,
): Promise<{ raw: string; responseModel?: string }> => {
  const candidates = [modelId(), ...fallbackModels()];
  let lastFailure: ModelFailure | undefined;
  for (let attempt = 0; attempt < Math.max(1, RETRY_ATTEMPTS); attempt += 1) {
    if (attempt > 0) {
      // Exponential backoff, honouring Retry-After when the provider sends it.
      await sleep(
        lastFailure?.retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempt - 1),
      );
    }
    // Within one attempt, try each candidate model before backing off again.
    for (const candidate of candidates) {
      try {
        return await callModelOnce(context, lastToolOutcome, candidate);
      } catch (error) {
        if (!(error instanceof ModelFailure) || !error.retryable) throw error;
        lastFailure = error;
      }
    }
  }
  throw (
    lastFailure ??
    new ModelFailure("provider", "model endpoint failed with no recorded error")
  );
};

const callModelOnce = async (
  context: PolicyStepContext,
  lastToolOutcome: StructuredToolOutcome | null,
  candidateModel: string,
): Promise<{ raw: string; responseModel?: string }> => {
  const apiKey =
    process.env["TINKER_API_KEY"] ?? process.env["BBGM_MODEL_API_KEY"];
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }
  let response: Response;
  try {
    response = await fetch(`${modelBaseUrl()}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(
        Number(process.env["BBGM_MODEL_TIMEOUT_MS"] ?? 120_000),
      ),
      body: JSON.stringify({
        model: candidateModel,
        messages: [
          { role: "system", content: promptText },
          {
            role: "user",
            content: observationPrompt(context.observation, lastToolOutcome),
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: Number(process.env["BBGM_MODEL_MAX_TOKENS"] ?? 96),
        ...(process.env["BBGM_MODEL_SEED"] === undefined
          ? {}
          : { seed: Number(process.env["BBGM_MODEL_SEED"]) }),
      }),
    });
  } catch (error) {
    throw new ModelFailure(
      "provider",
      `model endpoint request failed: ${errorMessage(error)}`,
      true,
    );
  }

  let body: ChatCompletionResponse & { error?: unknown };
  try {
    body = (await response.json()) as ChatCompletionResponse & {
      error?: unknown;
    };
  } catch (error) {
    throw new ModelFailure(
      "provider",
      `model endpoint returned invalid JSON: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ModelFailure(
      "provider",
      `model endpoint returned HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`,
      isRetryableStatus(response.status),
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(60_000, retryAfter * 1000)
        : undefined,
    );
  }
  let raw: string;
  try {
    raw = contentText(body);
  } catch (error) {
    throw new ModelFailure("model", errorMessage(error));
  }
  return {
    raw,
    ...(typeof body.model === "string" ? { responseModel: body.model } : {}),
  };
};

const appendTrace = async (
  context: PolicyStepContext,
  payload: unknown,
): Promise<void> => {
  const traceRoot = process.env["BBGM_MODEL_TRACE_DIR"];
  if (traceRoot === undefined || traceRoot.length === 0) return;
  const path = resolve(traceRoot, `${context.seed}.model.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8");
};

export const createPolicyAdapter = ({
  policyName,
  seed,
}: AdapterFactoryInput): PolicyAdapter => {
  requiredPolicy(policyName);
  const endpoint = modelBaseUrl();
  const selectedModel = modelId();
  const selectedModelRevision = modelRevision();
  let requestCount = 0;
  let lastToolOutcome: StructuredToolOutcome | null = null;
  const telemetry: PolicyTelemetry = {
    modelCallCount: 0,
    parseErrorCount: 0,
    providerErrorCount: 0,
    modelErrorCount: 0,
    toolErrorCount: 0,
  };
  return {
    metadata: {
      name: "untrained_open_model",
      label: "Untrained open-weight model via OpenAI-compatible sampler",
      kind: "external_model",
      version: "openai-compatible-chat-v1",
      available: true,
      provider: endpoint.includes("tinker.thinkingmachines.dev")
        ? "thinking-machines-tinker-openai-compatible"
        : "local-openai-compatible",
      modelId: selectedModel,
      ...(selectedModelRevision === undefined
        ? {}
        : { modelRevision: selectedModelRevision }),
      promptVersion: PROMPT_VERSION,
      promptSha256,
      endpoint,
      decoding: {
        temperature: 0,
        maxTokens: 96,
        ...(process.env["BBGM_MODEL_SEED"] === undefined
          ? {}
          : { seed: Number(process.env["BBGM_MODEL_SEED"]) }),
      },
    },
    getTelemetry: () => ({ ...telemetry }),
    step: async (context) => {
      const request = requestCount;
      requestCount += 1;
      telemetry.modelCallCount += 1;
      const startedAt = new Date().toISOString();
      let rawOutput: string | undefined;
      let parsedAction: ExternalAction | undefined;
      const previousToolOutcome = lastToolOutcome;
      let result: { raw: string; responseModel?: string };
      try {
        result = await callModel(context, previousToolOutcome);
        rawOutput = result.raw;
      } catch (error) {
        const failureKind =
          error instanceof ModelFailure ? error.failureKind : "provider";
        if (failureKind === "provider") telemetry.providerErrorCount += 1;
        else telemetry.modelErrorCount += 1;
        await appendTrace(context, {
          schemaVersion: "open-model-trace.v2",
          seed,
          request,
          startedAt,
          modelId: selectedModel,
          endpoint,
          promptVersion: PROMPT_VERSION,
          promptSha256,
          observation: context.observation,
          previousToolOutcome,
          rawModelOutput: null,
          parsedAction: null,
          toolOutcome: null,
          outcome: `${failureKind}_error`,
          continued: false,
          failureKind,
          error: errorDetails(error),
        });
        throw error;
      }
      const responseModel = result.responseModel ?? null;

      try {
        parsedAction = parseAction(result.raw);
      } catch (error) {
        telemetry.parseErrorCount += 1;
        const toolOutcome = failedToolOutcome(null, "parse", error);
        lastToolOutcome = toolOutcome;
        await appendTrace(context, {
          schemaVersion: "open-model-trace.v2",
          seed,
          request,
          startedAt,
          modelId: selectedModel,
          endpoint,
          promptVersion: PROMPT_VERSION,
          promptSha256,
          observation: context.observation,
          previousToolOutcome,
          rawModelOutput: rawOutput,
          parsedAction: null,
          toolOutcome,
          outcome: "parse_error",
          continued: true,
          responseModel,
          error: errorDetails(error),
        });
        return { kind: "continue", revision: context.revision };
      }

      try {
        const applied = await applyAction(context, parsedAction);
        const toolOutcome: StructuredToolOutcome = {
          status: "ok",
          toolName: parsedAction.toolName,
          result: applied.result,
        };
        lastToolOutcome = toolOutcome;
        await appendTrace(context, {
          schemaVersion: "open-model-trace.v2",
          seed,
          request,
          startedAt,
          modelId: selectedModel,
          endpoint,
          promptVersion: PROMPT_VERSION,
          promptSha256,
          observation: context.observation,
          previousToolOutcome,
          rawModelOutput: rawOutput,
          parsedAction,
          toolOutcome,
          outcome: "tool_success",
          continued: true,
          responseModel,
        });
        return { kind: "continue", revision: applied.revision };
      } catch (error) {
        telemetry.toolErrorCount += 1;
        const toolOutcome = failedToolOutcome(
          parsedAction.toolName,
          "tool",
          error,
        );
        lastToolOutcome = toolOutcome;
        await appendTrace(context, {
          schemaVersion: "open-model-trace.v2",
          seed,
          request,
          startedAt,
          modelId: selectedModel,
          endpoint,
          promptVersion: PROMPT_VERSION,
          promptSha256,
          observation: context.observation,
          previousToolOutcome,
          rawModelOutput: rawOutput,
          parsedAction,
          toolOutcome,
          outcome: "tool_error",
          continued: true,
          responseModel,
          error: errorDetails(error),
        });
        return { kind: "continue", revision: context.revision };
      }
    },
  };
};

export default createPolicyAdapter;
