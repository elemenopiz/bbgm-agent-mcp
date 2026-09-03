import { describe, expect, test } from "vitest";

import type { AttemptRecord } from "../../src/persistence/attemptLog.js";
import { summarizeTrajectory } from "../../src/research/trajectory.js";

const makeAttempt = (
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord => ({
  episodeId: "episode-1",
  sequence: 0,
  timestamp: "2026-01-01T00:00:00.000Z",
  operation: "bbgm_advance",
  kind: "mutation",
  outcome: "accepted",
  ...overrides,
});

describe("summarizeTrajectory attempt attribution", () => {
  test("counts policy actions and rejected actions, excluding non-action records", () => {
    const summary = summarizeTrajectory(
      [],
      [
        makeAttempt({ actor: "evaluator", operation: "bbgm_get_state" }),
        makeAttempt({ kind: "lifecycle", operation: "bbgm_create_episode" }),
        makeAttempt({ operation: "bbgm_get_state" }),
        makeAttempt({ outcome: "accepted" }),
        makeAttempt({ outcome: "rejected", outcomeCode: "ILLEGAL_ACTION" }),
        makeAttempt({ outcome: "rejected", outcomeCode: "REVISION_CONFLICT" }),
        makeAttempt({ outcome: "idempotent_replay" }),
      ],
    );

    expect(summary.agentAttemptCount).toBe(4);
    expect(summary.rejectedAttemptCount).toBe(2);
    expect(summary.staleActionCount).toBe(1);
    expect(summary.idempotentReplayCount).toBe(1);
  });

  test("keeps legacy action records without an actor field measurable", () => {
    const summary = summarizeTrajectory([], [makeAttempt()]);

    expect(summary.agentAttemptCount).toBe(1);
  });
});
