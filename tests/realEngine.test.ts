import { describe, expect, test } from "vitest";

import { BasketballGmEngine } from "../src/engine/bbgm/BasketballGmEngine.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";

const runRealEngine = process.env["BBGM_REAL_ENGINE"] === "1";

describe.skipIf(!runRealEngine)("BasketballGmEngine", () => {
  test(
    "creates, advances, snapshots, and restores a real league",
    { timeout: 120_000 },
    async () => {
      const manager = new EpisodeManager(() => new BasketballGmEngine());
      try {
        console.error("real-engine: create");
        const initial = await manager.create({
          scenarioId: "real-smoke",
          seed: "20260825",
          userTeamId: 0,
          startingSeason: 2026,
        });
        expect(initial.engine.name).toBe("basketball-gm");
        expect(initial.roster.length).toBeGreaterThanOrEqual(10);
        console.error("real-engine: checkpoint");
        const checkpoint = await manager.createCheckpoint(initial.episodeId);
        console.error("real-engine: advance");
        const advanced = await manager.advance(
          initial.episodeId,
          { target: "next_game" },
          { expectedRevision: 0, idempotencyKey: "real-advance-0001" },
        );
        expect(advanced.revision).toBe(1);
        console.error("real-engine: restore");
        const restored = await manager.restoreCheckpoint(
          initial.episodeId,
          checkpoint.checkpointId,
          { expectedRevision: 1, idempotencyKey: "real-restore-0001" },
        );
        expect(restored.revision).toBe(2);
        console.error("real-engine: state");
        const final = await manager.getState(initial.episodeId);
        expect(final.userTeam.won + final.userTeam.lost).toBe(0);
      } finally {
        console.error("real-engine: close");
        await manager.close();
      }
    },
  );
});
