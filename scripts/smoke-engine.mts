#!/usr/bin/env -S node --experimental-strip-types
// Automated version of the project spec's "HEADLESS ENGINE SPIKE" checklist,
// run via `pnpm engine:smoke`. This actually exercises the real Basketball
// GM engine end to end -- it is NOT a fake/mocked run. See
// docs/ENGINE_INTEGRATION.md for what this proves and does not prove.
//
// Fails closed: if BBGM_SOURCE_DIR is unset, or scripts/verify-engine.ts
// does not pass, this prints a clear message and exits non-zero rather than
// silently no-op-succeeding. It never fabricates a passing result.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { BasketballGmEngine } from "../src/engine/bbgm/BasketballGmEngine.js";
import { stateHash } from "../src/domain/stateHash.js";
import type { CreateEpisodeInput, EngineEvent } from "../src/domain/types.js";

const root = resolve(import.meta.dirname, "..");
const SMOKE_STARTING_SEASON = 2026;

const sourceDirEnv = process.env["BBGM_SOURCE_DIR"];
if (!sourceDirEnv) {
  console.error(
    "engine:smoke: BBGM_SOURCE_DIR is not set. This script requires a real, separately-obtained " +
      "local checkout of Basketball GM at the commit pinned in bbgm-engine.lock.json -- this " +
      "project does not download or vendor it. Set BBGM_SOURCE_DIR to that checkout's path " +
      "(e.g. `export BBGM_SOURCE_DIR=/path/to/your/zengm/checkout`) and re-run `pnpm engine:verify` " +
      "then `pnpm engine:smoke`.",
  );
  process.exit(1);
}
const sourceDir = resolve(sourceDirEnv);

console.error("engine:smoke: running scripts/verify-engine.ts first...");
try {
  execFileSync(process.execPath, [resolve(root, "scripts/verify-engine.ts")], {
    stdio: "inherit",
    env: process.env,
  });
} catch {
  console.error(
    "engine:smoke: engine:verify failed (see above). Fix that first -- refusing to run the " +
      "spike against an unverified checkout.",
  );
  process.exit(1);
}

console.error(
  "engine:smoke: building the engine bridge (scripts/build-engine-bridge.ts)...",
);
execFileSync(
  process.execPath,
  [resolve(root, "scripts/build-engine-bridge.ts")],
  {
    stdio: "inherit",
    env: process.env,
  },
);

// -- helpers -----------------------------------------------------------------

const summarize = (label: string, events: EngineEvent[]): void => {
  const types = events.map((e) => e.type).join(", ");
  console.error(`  [${label}] ${events.length} event(s): ${types}`);
};

const BOUND_SEASON_ADVANCE_STEPS = 20;

async function runSpike(): Promise<void> {
  const engine = new BasketballGmEngine({ sourceDir });
  const startedAt = Date.now();
  try {
    const input: CreateEpisodeInput = {
      episodeId: `smoke-${Date.now()}`,
      scenarioId: "engine-smoke-test",
      seed: "engine-smoke-seed-1",
      userTeamId: 0,
      startingSeason: SMOKE_STARTING_SEASON,
      constraints: { hard: [], soft: [] },
    };

    console.error("\n=== 1. create() ===");
    await engine.create(input);
    console.error(`engine.metadata = ${JSON.stringify(engine.metadata)}`);

    console.error("\n=== 2. getRawState() ===");
    const state1 = await engine.getRawState();
    console.error(
      `season=${state1.season} phase=${state1.phase} userTeam=${state1.userTeam.name} ` +
        `(${state1.userTeam.abbrev}) roster=${state1.roster.length} freeAgents=${state1.freeAgents.length} ` +
        `ownedPicks=${state1.ownedPicks.length} draftPicks=${state1.draftPicks.length} standings=${state1.standings.length} ` +
        `schedule=${state1.schedule.length} payroll=${state1.userTeam.payroll.toFixed(1)}M ` +
        `capSpace=${state1.userTeam.capSpace.toFixed(1)}M nextDecision=${state1.nextDecision}`,
    );
    if (state1.roster.length === 0)
      throw new Error(
        "Spike check failed: user roster is empty after create()",
      );
    if (state1.draftPicks.length < state1.ownedPicks.length) {
      throw new Error(
        "Spike check failed: complete draft-pick ledger is smaller than the user's owned-pick subset",
      );
    }
    const firstPlayer = state1.roster[0];
    if (firstPlayer) {
      console.error(
        `  sample player: ${firstPlayer.name} (${firstPlayer.position}, ovr ${firstPlayer.overall}, ` +
          `pot ${firstPlayer.potential}, $${firstPlayer.contractAmount.toFixed(1)}M x${firstPlayer.contractExpires - state1.season})`,
      );
    }

    console.error("\n=== 3. getOptions() ===");
    const options = await engine.getOptions();
    console.error(
      `  ${options.length} option(s), first few: ${JSON.stringify(options.slice(0, 3))}`,
    );

    console.error("\n=== 4. advance({ target: 'next_game' }) ===");
    const gameEvents = await engine.advance({ target: "next_game" });
    summarize("next_game", gameEvents);

    console.error("\n=== 4b. advance({ target: 'until_trade_deadline' }) ===");
    const deadlineEvents = await engine.advance({
      target: "until_trade_deadline",
    });
    summarize("until_trade_deadline", deadlineEvents);
    const deadlineState = await engine.getRawState();
    if (deadlineState.phase !== "regular_season") {
      throw new Error(
        `Spike check failed: trade-deadline milestone ended in ${deadlineState.phase}`,
      );
    }

    console.error("\n=== 5. advance through one full season (bounded) ===");
    const seasonAtStart = (await engine.getRawState()).season;
    let steps = 0;
    let stoppedReason = "";
    for (; steps < BOUND_SEASON_ADVANCE_STEPS; steps += 1) {
      const events = await engine.advance({ target: "phase" });
      const complete = events.find((e) => e.type === "advance_complete");
      stoppedReason =
        typeof complete?.["reason"] === "string"
          ? complete["reason"]
          : "unknown";
      const afterState = await engine.getRawState();
      console.error(
        `  step ${steps + 1}: phase -> ${afterState.phase} (season ${afterState.season}), stop reason: ${stoppedReason}`,
      );
      if (
        stoppedReason === "blocked_pending_decision" &&
        afterState.phase === "draft"
      ) {
        // A pending user draft pick -- auto-pick the top prospect so the
        // bounded season loop can keep moving, mirroring what an LLM GM
        // acting on get_options() would do.
        const s = await engine.getRawState();
        const prospect = s.draftProspects[0];
        if (!prospect)
          throw new Error(
            "Spike check failed: blocked on draft pick but no prospects available",
          );
        console.error(
          `  making draft pick: ${prospect.name} (pid ${prospect.pid})`,
        );
        const draftEvents = await engine.makeDraftPick({ pid: prospect.pid });
        summarize("makeDraftPick", draftEvents);
      } else if (stoppedReason === "blocked_pending_decision") {
        // Resigning negotiations are intentionally never auto-resolved by
        // the adapter. Stop the smoke walk here and verify snapshot behavior
        // at this safe decision boundary instead of silently choosing terms.
        console.error(
          `  stopping at ${afterState.nextDecision}; the adapter requires an explicit contract decision`,
        );
        break;
      }
      if (afterState.season !== seasonAtStart) break;
    }
    const seasonAfterWalk = (await engine.getRawState()).season;
    if (steps >= BOUND_SEASON_ADVANCE_STEPS) {
      console.error(
        `  WARNING: hit the ${BOUND_SEASON_ADVANCE_STEPS}-step bound without completing a season transition`,
      );
    } else if (seasonAfterWalk === seasonAtStart) {
      console.error(
        `  season walk stopped safely at a required ${
          (await engine.getRawState()).nextDecision
        } decision before crossing the season boundary`,
      );
    } else {
      console.error(
        `  season advanced ${seasonAtStart} -> ${seasonAfterWalk} in ${steps + 1} phase step(s)`,
      );
    }

    console.error("\n=== 6. exportSnapshot() / importSnapshot() ===");
    const beforeSnapshotState = await engine.getRawState();
    const snapshot = await engine.exportSnapshot();
    console.error(
      `  exported snapshot (top-level keys: ${Object.keys(snapshot as Record<string, unknown>).join(", ")})`,
    );
    await engine.importSnapshot(snapshot);
    const afterSnapshotState = await engine.getRawState();
    const consistent =
      stateHash(beforeSnapshotState) === stateHash(afterSnapshotState) &&
      afterSnapshotState.season === beforeSnapshotState.season &&
      afterSnapshotState.phase === beforeSnapshotState.phase &&
      afterSnapshotState.roster.length === beforeSnapshotState.roster.length;
    console.error(
      `  post-import state consistent with pre-export state: ${consistent}`,
    );
    if (!consistent) {
      throw new Error(
        `Spike check failed: state diverged across export/import ` +
          `(before: season=${beforeSnapshotState.season} phase=${beforeSnapshotState.phase} roster=${beforeSnapshotState.roster.length}; ` +
          `after: season=${afterSnapshotState.season} phase=${afterSnapshotState.phase} roster=${afterSnapshotState.roster.length})`,
      );
    }

    console.error(
      "\n=== 7. advance one more game post-import (sanity check) ===",
    );
    summarize(
      "post-import next_game",
      await engine.advance({ target: "next_game" }),
    );

    const elapsedMs = Date.now() - startedAt;
    console.error(
      `\nengine:smoke: PASSED in ${(elapsedMs / 1000).toFixed(1)}s`,
    );
  } finally {
    await engine.close();
  }
}

try {
  await runSpike();
} catch (error) {
  console.error("\nengine:smoke: FAILED");
  console.error(error);
  process.exit(1);
}
