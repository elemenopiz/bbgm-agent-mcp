import { describe, expect, test } from "vitest";

import { DemoEngine } from "../src/engine/demo/DemoEngine.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";

const createManager = () => new EpisodeManager(() => new DemoEngine());

describe("EpisodeManager", () => {
  test("replays the same seed and action sequence deterministically", async () => {
    const manager = createManager();
    const first = await manager.create({ scenarioId: "determinism", seed: "42", userTeamId: 0, startingSeason: 2026 });
    const second = await manager.create({ scenarioId: "determinism", seed: "42", userTeamId: 0, startingSeason: 2026 });

    const firstResult = await manager.advance(first.episodeId, { target: "games", count: 10 }, { expectedRevision: 0, idempotencyKey: "first-run-0001" });
    const secondResult = await manager.advance(second.episodeId, { target: "games", count: 10 }, { expectedRevision: 0, idempotencyKey: "second-run-001" });

    const firstState = await manager.getState(first.episodeId);
    const secondState = await manager.getState(second.episodeId);
    expect({ ...firstState, episodeId: "same" }).toEqual({ ...secondState, episodeId: "same" });
    expect(firstResult.events).toEqual(secondResult.events);
    await manager.close();
  });

  test("makes mutation retries idempotent and rejects stale revisions", async () => {
    const manager = createManager();
    const state = await manager.create({ scenarioId: "revision", seed: "7", userTeamId: 0, startingSeason: 2026 });
    const context = { expectedRevision: 0, idempotencyKey: "advance-00000001" };
    const first = await manager.advance(state.episodeId, { target: "next_game" }, context);
    const retry = await manager.advance(state.episodeId, { target: "next_game" }, context);
    expect(retry).toEqual(first);
    await expect(
      manager.advance(state.episodeId, { target: "next_game" }, { expectedRevision: 0, idempotencyKey: "advance-00000002" }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await manager.close();
  });

  test("restores a checkpoint without rewinding the monotonic revision", async () => {
    const manager = createManager();
    const state = await manager.create({ scenarioId: "checkpoint", seed: "11", userTeamId: 0, startingSeason: 2026 });
    const checkpoint = await manager.createCheckpoint(state.episodeId);
    await manager.advance(state.episodeId, { target: "games", count: 5 }, { expectedRevision: 0, idempotencyKey: "advance-checkpoint" });
    const restored = await manager.restoreCheckpoint(state.episodeId, checkpoint.checkpointId, { expectedRevision: 1, idempotencyKey: "restore-checkpoint" });
    expect(restored.revision).toBe(2);
    expect((await manager.getState(state.episodeId)).userTeam.won).toBe(0);
    await manager.close();
  });
});

