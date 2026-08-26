import { describe, expect, test } from "vitest";

import {
  evaluateScenarioConstraints,
  hasHardFailure,
  runBuiltinInvariants,
} from "../../src/domain/invariants.js";
import type { EngineRawState } from "../../src/domain/types.js";

const baseState: EngineRawState = {
  season: 2026,
  phase: "regular_season",
  day: 1,
  userTeam: {
    tid: 0,
    name: "Test",
    abbrev: "TST",
    won: 5,
    lost: 3,
    conference: "A",
    division: "B",
    standing: 1,
    payroll: 100,
    salaryCap: 140,
    capSpace: 40,
    luxuryTaxThreshold: 168,
    hardCapActive: false,
  },
  roster: Array.from({ length: 12 }, (_, i) => ({
    pid: i + 1,
    name: `P${i + 1}`,
    age: 25,
    position: "PG",
    overall: 70,
    potential: 75,
    contractAmount: 5,
    contractExpires: 2028,
    injuryGamesRemaining: 0,
    role: "bench" as const,
    rosterOrder: i,
  })),
  freeAgents: [],
  draftProspects: [],
  ownedPicks: [
    { dpid: 1, season: 2027, round: 1, originalTeamId: 0, currentTeamId: 0 },
  ],
  standings: [],
  schedule: [],
  recentTransactions: [],
  legalActionCategories: [],
  nextDecision: "play_next_game",
};

describe("runBuiltinInvariants", () => {
  test("all pass for a well-formed state", () => {
    const statuses = runBuiltinInvariants(baseState, 2026);
    expect(hasHardFailure(statuses)).toBe(false);
  });

  test("flags roster size below the minimum", () => {
    const state: EngineRawState = {
      ...baseState,
      roster: baseState.roster.slice(0, 5),
    };
    const statuses = runBuiltinInvariants(state, 2026);
    expect(statuses.find((s) => s.code === "ROSTER_SIZE")?.satisfied).toBe(
      false,
    );
    expect(hasHardFailure(statuses)).toBe(true);
  });

  test("flags roster size above the maximum", () => {
    const extra = Array.from({ length: 4 }, (_, i) => ({
      ...baseState.roster[0]!,
      pid: 100 + i,
    }));
    const state: EngineRawState = {
      ...baseState,
      roster: [...baseState.roster, ...extra],
    };
    expect(
      runBuiltinInvariants(state, 2026).find((s) => s.code === "ROSTER_SIZE")
        ?.satisfied,
    ).toBe(false);
  });

  test("flags duplicate player ownership", () => {
    const state: EngineRawState = {
      ...baseState,
      roster: [
        baseState.roster[0]!,
        baseState.roster[0]!,
        ...baseState.roster.slice(2),
      ],
    };
    expect(
      runBuiltinInvariants(state, 2026).find(
        (s) => s.code === "NO_DUPLICATE_PLAYERS",
      )?.satisfied,
    ).toBe(false);
  });

  test("flags duplicate draft pick ownership", () => {
    const state: EngineRawState = {
      ...baseState,
      ownedPicks: [baseState.ownedPicks[0]!, baseState.ownedPicks[0]!],
    };
    expect(
      runBuiltinInvariants(state, 2026).find(
        (s) => s.code === "NO_DUPLICATE_PICKS",
      )?.satisfied,
    ).toBe(false);
  });

  test("flags a non-positive contract amount", () => {
    const roster = [
      { ...baseState.roster[0]!, contractAmount: 0 },
      ...baseState.roster.slice(1),
    ];
    const state: EngineRawState = { ...baseState, roster };
    expect(
      runBuiltinInvariants(state, 2026).find(
        (s) => s.code === "VALID_CONTRACTS",
      )?.satisfied,
    ).toBe(false);
  });

  test("flags an expired contract", () => {
    const roster = [
      { ...baseState.roster[0]!, contractExpires: 2020 },
      ...baseState.roster.slice(1),
    ];
    const state: EngineRawState = { ...baseState, roster };
    expect(
      runBuiltinInvariants(state, 2026).find(
        (s) => s.code === "VALID_CONTRACTS",
      )?.satisfied,
    ).toBe(false);
  });

  test("cap compliance is a soft constraint unless the hard cap is active", () => {
    const state: EngineRawState = {
      ...baseState,
      userTeam: { ...baseState.userTeam, payroll: 200, hardCapActive: false },
    };
    const statuses = runBuiltinInvariants(state, 2026);
    const cap = statuses.find((s) => s.code === "CAP_COMPLIANCE");
    expect(cap?.kind).toBe("soft");
    expect(hasHardFailure(statuses)).toBe(false);
  });

  test("cap compliance is a hard failure when the hard cap is active and exceeded", () => {
    const state: EngineRawState = {
      ...baseState,
      userTeam: { ...baseState.userTeam, payroll: 200, hardCapActive: true },
    };
    const statuses = runBuiltinInvariants(state, 2026);
    expect(statuses.find((s) => s.code === "CAP_COMPLIANCE")?.satisfied).toBe(
      false,
    );
    expect(hasHardFailure(statuses)).toBe(true);
  });

  test("flags non-finite numeric values", () => {
    const roster = [
      { ...baseState.roster[0]!, overall: Number.NaN },
      ...baseState.roster.slice(1),
    ];
    const state: EngineRawState = { ...baseState, roster };
    expect(
      runBuiltinInvariants(state, 2026).find((s) => s.code === "FINITE_VALUES")
        ?.satisfied,
    ).toBe(false);
  });

  test("flags season regression before the starting season", () => {
    expect(
      runBuiltinInvariants(baseState, 2030).find(
        (s) => s.code === "SEASON_PROGRESSION",
      )?.satisfied,
    ).toBe(false);
  });

  test("flags invalid lineup/roster-order representation", () => {
    const roster = baseState.roster.map((p) => ({ ...p, rosterOrder: 0 }));
    const state: EngineRawState = { ...baseState, roster };
    expect(
      runBuiltinInvariants(state, 2026).find((s) => s.code === "LINEUP_VALID")
        ?.satisfied,
    ).toBe(false);
  });
});

describe("evaluateScenarioConstraints", () => {
  test("an unregistered custom code is reported satisfied with a note, not silently dropped", () => {
    const builtins = runBuiltinInvariants(baseState, 2026);
    const declared = evaluateScenarioConstraints(
      {
        hard: [
          { code: "CUSTOM_RULE", description: "A scenario-specific rule" },
        ],
        soft: [],
      },
      builtins,
    );
    expect(declared[0]?.satisfied).toBe(true);
    expect(declared[0]?.message).toContain("no built-in evaluator");
  });

  test("a code matching a built-in reuses the built-in's satisfaction result", () => {
    const state: EngineRawState = {
      ...baseState,
      roster: baseState.roster.slice(0, 3),
    };
    const builtins = runBuiltinInvariants(state, 2026);
    const declared = evaluateScenarioConstraints(
      {
        hard: [{ code: "ROSTER_SIZE", description: "Keep a legal roster" }],
        soft: [],
      },
      builtins,
    );
    expect(declared[0]?.satisfied).toBe(false);
  });
});
