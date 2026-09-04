/**
 * Agent 6: can a capable model actually operate this environment?
 *
 * Drives a real Basketball GM episode with a real model through the SAME typed
 * DomainService boundary the MCP tools use. No repaired actions, no shortcuts.
 * Every parse failure, provider failure, and rejected mutation is retained --
 * the failure rate IS the finding.
 *
 * Requires OPENROUTER_API_KEY (see .env.local) and BBGM_SOURCE_DIR.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DomainService } from "../src/domain/DomainService.js";
import { BasketballGmEngine } from "../src/engine/bbgm/BasketballGmEngine.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";
import { createFileSnapshotStore } from "../src/persistence/snapshots.js";
import type {
  DraftView,
  MutationContext,
  OverviewView,
  RosterView,
} from "../src/domain/types.js";

const MODELS = (
  process.env["PROBE_MODELS"] ??
  "minimax/minimax-m3:free,nvidia/nemotron-3-super-120b-a12b:free,inclusionai/ling-3.0-flash-fin:free"
).split(",");
const SEED = process.env["PROBE_SEED"] ?? "grant-seed-001";
const MAX_STEPS = Number(process.env["PROBE_STEPS"] ?? 25);
const START_SEASON = 2026;
// When 0, drop the hand-written free-agent paging and the min-salary hint.
// Those existed to compensate for information the environment did not expose;
// with the enriched surface they are the thing under test, not a fixture.
const SCAFFOLD = process.env["PROBE_SCAFFOLD"] !== "0";
const OBJECTIVE =
  process.env["PROBE_OBJECTIVE"] ??
  "Build the strongest possible team over the next several seasons.";

type Telemetry = {
  modelCalls: number;
  providerErrors: number;
  parseFailures: number;
  invalidActions: number;
  validActions: number;
  promptTokens: number;
  completionTokens: number;
};

const log: Record<string, unknown>[] = [];
let keyCounter = 0;
const ctx = (revision: number): MutationContext => ({
  expectedRevision: revision,
  idempotencyKey: `agent6-${(keyCounter += 1)}`,
});

const TOOLS = `Available tools (emit exactly ONE JSON object, no prose):
{"tool":"get_state","view":"overview"|"roster"|"draft"|"standings"|"finances"|"free_agents","limit":<1-50>,"cursor":<int|omit>}
{"tool":"advance","target":"next_decision"}
{"tool":"make_draft_pick","pid":<int>}
{"tool":"negotiate_contract","pid":<int>,"amount":<number>,"years":<int>}
{"tool":"release_player","pid":<int>}
{"tool":"sign_free_agent","pid":<int>,"amount":<number>,"years":<int>}
{"tool":"get_options"}`;

const asText = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v : fallback;

const callModel = async (
  prompt: string,
  tel: Telemetry,
): Promise<Record<string, unknown> | null> => {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  for (const model of MODELS) {
    tel.modelCalls += 1;
    let body: unknown;
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      body = await res.json();
    } catch (error) {
      tel.providerErrors += 1;
      log.push({
        kind: "provider_error",
        model,
        error: String(error).slice(0, 160),
      });
      continue;
    }
    const b = body as {
      error?: unknown;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (b.error !== undefined || !b.choices?.[0]) {
      tel.providerErrors += 1;
      log.push({
        kind: "provider_error",
        model,
        error: JSON.stringify(b.error).slice(0, 160),
      });
      continue;
    }
    tel.promptTokens += b.usage?.prompt_tokens ?? 0;
    tel.completionTokens += b.usage?.completion_tokens ?? 0;
    const text = b.choices[0].message?.content ?? "";
    const blocks = [...(text.match(/\{[^{}]*"tool"[^{}]*\}/g) ?? [])];
    for (const block of blocks.reverse()) {
      try {
        return JSON.parse(block) as Record<string, unknown>;
      } catch {
        /* try the next candidate block */
      }
    }
    tel.parseFailures += 1;
    log.push({ kind: "parse_failure", model, tail: text.slice(-200) });
    return null;
  }
  return null;
};

const main = async (): Promise<void> => {
  if (!process.env["BBGM_SOURCE_DIR"]) throw new Error("BBGM_SOURCE_DIR unset");
  const dataRoot = await mkdtemp(join(tmpdir(), "agent6-"));
  const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
  const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));
  const created = await domain.createEpisode({
    scenarioId: "agent6-capability-probe",
    seed: SEED,
    userTeamId: 0,
    startingSeason: START_SEASON,
  });
  const episodeId = created.episodeId;
  let revision = created.revision;
  const tel: Telemetry = {
    modelCalls: 0,
    providerErrors: 0,
    parseFailures: 0,
    invalidActions: 0,
    validActions: 0,
    promptTokens: 0,
    completionTokens: 0,
  };

  let lastError = "";
  let lastRead = "";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const ov = (await domain.getState({
      episodeId,
      view: "overview",
    })) as OverviewView;
    const roster = (await domain.getState({
      episodeId,
      view: "roster",
      limit: 20,
    })) as RosterView;
    let extra = "";
    if (ov.nextDecision === "make_draft_pick") {
      const d = (await domain.getState({
        episodeId,
        view: "draft",
        limit: 12,
      })) as DraftView;
      extra = `\nProspects: ${JSON.stringify(
        d.prospects.slice(0, 10).map((p) => ({
          pid: p.pid,
          ovr: p.scoutedOverall,
          pot: p.scoutedPotential,
          age: p.age,
        })),
      )}`;
    }
    if (SCAFFOLD && ov.rosterCount < 14) {
      // Page the whole pool, then surface what is actually signable at the
      // current cap position. Showing one truncated page hid 134
      // minimum-salary players and deadlocked the agent.
      type FA = {
        pid: number;
        age: number;
        overall: number;
        potential: number;
        contractAmount: number;
      };
      const all: FA[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < 6; page += 1) {
        const fa = (await domain.getState({
          episodeId,
          view: "free_agents",
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        })) as { players: FA[]; page?: { nextCursor?: number } };
        all.push(...fa.players);
        const next = fa.page?.nextCursor;
        if (next === undefined || next === null) break;
        cursor = next;
      }
      const ceiling = Math.max(ov.userTeam.capSpace, ov.userTeam.minContract);
      const signable = all
        .filter((p) => p.contractAmount <= ceiling)
        .sort((a, b) => b.overall - a.overall)
        .slice(0, 15);
      extra += `\nFree agents: ${all.length} total; ${signable.length} signable at your cap position (ceiling ${ceiling.toFixed(2)}M).\nBest signable: ${JSON.stringify(
        signable.map((p) => ({
          pid: p.pid,
          ovr: p.overall,
          pot: p.potential,
          age: p.age,
          asking: p.contractAmount,
        })),
      )}`;
    }

    // Bounded rolling observation -- never an accumulating transcript.
    const prompt = `You are the general manager of ${ov.userTeam.name}.
Objective: ${OBJECTIVE}

${TOOLS}

Season ${ov.season}, phase ${ov.phase}. Record ${ov.userTeam.won}-${ov.userTeam.lost}.
Roster size ${ov.rosterCount}. Cap space ${ov.userTeam.capSpace.toFixed(1)}.
Min contract ${ov.userTeam.minContract.toFixed(2)}, max ${ov.userTeam.maxContract.toFixed(1)}.${
      SCAFFOLD
        ? " Over the cap you may STILL sign free agents at the minimum salary."
        : ""
    }
Next required decision: ${ov.nextDecision}${lastError ? `\nYOUR LAST ACTION FAILED: ${lastError}` : ""}${lastRead}
Roster: ${JSON.stringify(
      roster.players.map((p) => ({
        pid: p.pid,
        age: p.age,
        ovr: p.overall,
        pot: p.potential,
        salary: p.contractAmount,
        expires: p.contractExpires,
      })),
    )}${extra}

Emit one tool call as JSON.`;

    const action = await callModel(prompt, tel);
    if (!action) {
      log.push({ kind: "no_action", step });
      continue;
    }
    const tool = asText(action["tool"], "");
    try {
      if (tool === "get_state") {
        // Honour the model's own paging. Without it a single truncated page
        // hid the minimum-salary free agents entirely, which reads as an
        // incapable policy when it is really an unreachable observation.
        const limit = Number(action["limit"]);
        const cursor = Number(action["cursor"]);
        const view = asText(action["view"], "overview");
        const page = await domain.getState({
          episodeId,
          view,
          ...(Number.isFinite(limit) && limit > 0
            ? { limit: Math.min(50, Math.trunc(limit)) }
            : {}),
          ...(Number.isFinite(cursor) ? { cursor: Math.trunc(cursor) } : {}),
        });
        lastRead =
          view === "free_agents"
            ? `\nfree_agents page you requested: ${JSON.stringify(page).slice(0, 3000)}`
            : "";
        tel.validActions += 1;
      } else if (tool === "advance") {
        const r = await domain.advance(
          episodeId,
          { target: asText(action["target"], "next_decision") },
          ctx(revision),
        );
        revision = r.revision;
        tel.validActions += 1;
      } else if (tool === "make_draft_pick") {
        const r = await domain.makeDraftPick(
          episodeId,
          { pid: Number(action["pid"]) },
          ctx(revision),
        );
        revision = r.revision;
        tel.validActions += 1;
      } else if (tool === "negotiate_contract") {
        const r = await domain.negotiateContract(
          episodeId,
          {
            pid: Number(action["pid"]),
            amount: Number(action["amount"]),
            years: Number(action["years"]),
          },
          ctx(revision),
        );
        revision = r.revision;
        tel.validActions += 1;
      } else if (tool === "release_player") {
        const r = await domain.releasePlayer(
          episodeId,
          { pid: Number(action["pid"]) },
          ctx(revision),
        );
        revision = r.revision;
        tel.validActions += 1;
      } else if (tool === "sign_free_agent") {
        const r = await domain.signFreeAgent(
          episodeId,
          {
            pid: Number(action["pid"]),
            amount: Number(action["amount"]),
            years: Number(action["years"]),
          },
          ctx(revision),
        );
        revision = r.revision;
        tel.validActions += 1;
      } else if (tool === "get_options") {
        await domain.getOptions(episodeId);
        tel.validActions += 1;
      } else {
        tel.invalidActions += 1;
        log.push({ kind: "unknown_tool", step, action });
        continue;
      }
      log.push({
        kind: "action",
        step,
        action,
        season: ov.season,
        phase: ov.phase,
      });
    } catch (error) {
      tel.invalidActions += 1;
      lastError = String(error).slice(0, 180);
      log.push({
        kind: "rejected",
        step,
        action,
        error: String(error).slice(0, 180),
      });
    }
  }

  const final = (await domain.getState({
    episodeId,
    view: "overview",
  })) as OverviewView;
  const outPath = join(
    process.cwd(),
    ".data",
    `agent6-probe-${SCAFFOLD ? "scaffolded" : "bare"}.json`,
  );
  await writeFile(
    outPath,
    JSON.stringify(
      {
        seed: SEED,
        scaffold: SCAFFOLD,
        models: MODELS,
        objective: OBJECTIVE,
        telemetry: tel,
        final,
        log,
      },
      null,
      2,
    ),
  );

  const denom = tel.validActions + tel.invalidActions + tel.parseFailures;
  process.stdout.write(`
=== AGENT 6: MODEL CAPABILITY ===
seed=${SEED} steps=${MAX_STEPS} scaffold=${SCAFFOLD}
model calls      ${tel.modelCalls}
valid actions    ${tel.validActions}
invalid actions  ${tel.invalidActions}
parse failures   ${tel.parseFailures}
provider errors  ${tel.providerErrors}
tokens           prompt=${tel.promptTokens} completion=${tel.completionTokens}
valid rate       ${denom > 0 ? ((tel.validActions / denom) * 100).toFixed(1) : "n/a"}%
final            season=${final.season} phase=${final.phase} record=${final.userTeam.won}-${final.userTeam.lost} roster=${final.rosterCount}
artifact         ${outPath}
`);
  await domain.endEpisode(episodeId).catch(() => undefined);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
