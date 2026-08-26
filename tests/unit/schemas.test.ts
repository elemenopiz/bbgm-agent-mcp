import { describe, expect, test } from "vitest";

import {
  advanceInputSchema,
  createEpisodeInputSchema,
  episodeIdSchema,
  getStateInputSchema,
  idempotencyKeySchema,
  mutationResultSchema,
  overviewViewSchema,
  setLineupInputSchema,
  tradeProposalSchema,
} from "../../src/domain/schemas.js";

describe("episodeIdSchema", () => {
  test("accepts a well-formed opaque ID", () => {
    expect(episodeIdSchema.safeParse("abc123_-XYZ").success).toBe(true);
  });

  test("rejects an empty string, path-like characters, and overly long values", () => {
    expect(episodeIdSchema.safeParse("").success).toBe(false);
    expect(episodeIdSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(episodeIdSchema.safeParse("a".repeat(200)).success).toBe(false);
  });
});

describe("idempotencyKeySchema", () => {
  test("rejects keys shorter than 8 characters", () => {
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
  });
});

describe("createEpisodeInputSchema", () => {
  test("applies defaults for userTeamId and startingSeason", () => {
    const result = createEpisodeInputSchema.parse({
      scenarioId: "s",
      seed: "1",
    });
    expect(result.userTeamId).toBe(0);
    expect(result.startingSeason).toBe(2026);
  });

  test("rejects unknown top-level fields", () => {
    expect(
      createEpisodeInputSchema.safeParse({
        scenarioId: "s",
        seed: "1",
        notAField: true,
      }).success,
    ).toBe(false);
  });

  test("rejects a startingSeason outside the sane range", () => {
    expect(
      createEpisodeInputSchema.safeParse({
        scenarioId: "s",
        seed: "1",
        startingSeason: 1500,
      }).success,
    ).toBe(false);
  });
});

describe("getStateInputSchema", () => {
  test("rejects an unknown view name", () => {
    expect(
      getStateInputSchema.safeParse({ episodeId: "abc", view: "not_a_view" })
        .success,
    ).toBe(false);
  });

  test("bounds limit to the documented maximum", () => {
    expect(
      getStateInputSchema.safeParse({
        episodeId: "abc",
        view: "roster",
        limit: 51,
      }).success,
    ).toBe(false);
    expect(
      getStateInputSchema.safeParse({
        episodeId: "abc",
        view: "roster",
        limit: 50,
      }).success,
    ).toBe(true);
  });
});

describe("advanceInputSchema", () => {
  test("requires count for target=games and target=days", () => {
    expect(advanceInputSchema.safeParse({ target: "games" }).success).toBe(
      false,
    );
    expect(advanceInputSchema.safeParse({ target: "days" }).success).toBe(
      false,
    );
    expect(
      advanceInputSchema.safeParse({ target: "games", count: 5 }).success,
    ).toBe(true);
  });

  test("does not require count for next_game, next_decision, phase, or season_end", () => {
    for (const target of [
      "next_game",
      "next_decision",
      "phase",
      "season_end",
    ] as const) {
      expect(advanceInputSchema.safeParse({ target }).success).toBe(true);
    }
  });

  test("bounds count to a maximum of 30", () => {
    expect(
      advanceInputSchema.safeParse({ target: "games", count: 31 }).success,
    ).toBe(false);
    expect(
      advanceInputSchema.safeParse({ target: "games", count: 30 }).success,
    ).toBe(true);
  });
});

describe("setLineupInputSchema", () => {
  test("rejects an empty order and more than 20 entries", () => {
    expect(setLineupInputSchema.safeParse({ order: [] }).success).toBe(false);
    expect(
      setLineupInputSchema.safeParse({
        order: Array.from({ length: 21 }, (_, i) => i),
      }).success,
    ).toBe(false);
  });
});

describe("tradeProposalSchema", () => {
  test("accepts a mix of player and draft-pick assets", () => {
    const result = tradeProposalSchema.safeParse({
      otherTeamId: 1,
      offered: [{ type: "player", pid: 1 }],
      requested: [{ type: "draft_pick", dpid: 2 }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an asset with an unknown discriminant", () => {
    const result = tradeProposalSchema.safeParse({
      otherTeamId: 1,
      offered: [{ type: "cash", amount: 5 }],
      requested: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("output schema conformance", () => {
  test("overviewViewSchema accepts a well-formed overview and rejects a malformed one", () => {
    const good = {
      schemaVersion: "1",
      view: "overview",
      episodeId: "abc123",
      revision: 0,
      stateHash: "a".repeat(64),
      season: 2026,
      phase: "preseason",
      status: "active",
      userTeam: {
        tid: 0,
        name: "T",
        abbrev: "T",
        won: 0,
        lost: 0,
        conference: "A",
        division: "B",
        standing: 1,
        payroll: 0,
        salaryCap: 140,
        capSpace: 140,
        luxuryTaxThreshold: 168,
        hardCapActive: false,
      },
      rosterCount: 12,
      rosterExcerpt: [],
      ownedPickCount: 6,
      constraintsSatisfied: true,
      legalActionCategories: ["advance"],
      nextDecision: "play_next_game",
    };
    expect(overviewViewSchema.safeParse(good).success).toBe(true);
    expect(
      overviewViewSchema.safeParse({ ...good, stateHash: "too-short" }).success,
    ).toBe(false);
    expect(
      overviewViewSchema.safeParse({ ...good, phase: "not_a_phase" }).success,
    ).toBe(false);
  });

  test("mutationResultSchema rejects an unknown top-level field (strict object)", () => {
    expect(
      mutationResultSchema.safeParse({
        episodeId: "abc",
        previousRevision: 0,
        revision: 1,
        stateHash: "a".repeat(64),
        appliedAction: {},
        events: [],
        warnings: [],
        nextDecision: "x",
        stateSummary: {},
        unexpectedExtra: true,
      }).success,
    ).toBe(false);
  });
});
