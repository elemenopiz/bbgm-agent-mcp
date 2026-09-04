import { describe, expect, test } from "vitest";

import { canonicalizeForHash, stateHash } from "../../src/domain/stateHash.js";
import {
  PLAYER_SUMMARY_DERIVED_FIELDS,
  type EngineRawState,
  type PlayerSummary,
} from "../../src/domain/types.js";

describe("stateHash", () => {
  test("is independent of object key insertion order", () => {
    expect(stateHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stateHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("changes when a value changes", () => {
    expect(stateHash({ revision: 0, a: 1 })).not.toBe(
      stateHash({ revision: 1, a: 1 }),
    );
  });

  test("is stable across repeated calls with equivalent input", () => {
    const value = { season: 2026, roster: [{ pid: 1, overall: 70 }] };
    expect(stateHash(value)).toBe(stateHash(structuredClone(value)));
  });

  test("produces a 64-character lowercase hex digest", () => {
    expect(stateHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * Regression guard for a defect that quarantined healthy episodes: derived
 * roster enrichment sourced from zengm's roster view was participating in the
 * episode state hash. Two properties broke reproducibility.
 *
 * 1. Mood-derived floats (`probWilling`) are not bit-reproducible across a
 *    snapshot export/import round trip, so a correctly restored snapshot
 *    hashed differently from the pre-action state.
 * 2. Roster array order is presentation. Sorting on a tied key left it
 *    dependent on raw-row iteration order, which a round trip does not
 *    preserve.
 *
 * Both made rollback verification and cross-process replay non-deterministic.
 */
const player = (
  pid: number,
  over: Partial<PlayerSummary> = {},
): PlayerSummary => ({
  pid,
  name: `Player ${pid}`,
  age: 25,
  position: "PG",
  overall: 50,
  potential: 60,
  contractAmount: 5,
  contractExpires: 2030,
  injuryGamesRemaining: 0,
  role: "bench",
  rosterOrder: pid,
  ...over,
});

const state = (roster: PlayerSummary[]): EngineRawState =>
  ({
    season: 2026,
    phase: "regular_season",
    userTeam: { name: "Test" },
    roster,
    freeAgents: [],
    draftProspects: [],
    draftPicks: [],
    ownedPicks: [],
    standings: [],
    schedule: [],
    recentTransactions: [],
    legalActionCategories: [],
    nextDecision: "advance",
  }) as unknown as EngineRawState;

describe("canonicalizeForHash", () => {
  test("drops every derived enrichment field from the hashed projection", () => {
    const enriched = player(1, {
      probWilling: 0.999999966671512,
      per: 25.44,
      skills: ["3", "B"],
      overallChange: 2,
      untradable: false,
      gamesPlayed: 23,
    });
    const projected = canonicalizeForHash(state([enriched]))
      .roster[0] as Record<string, unknown>;

    for (const field of PLAYER_SUMMARY_DERIVED_FIELDS) {
      expect(projected).not.toHaveProperty(field);
    }
    // State of record survives untouched.
    expect(projected["pid"]).toBe(1);
    expect(projected["overall"]).toBe(50);
    expect(projected["contractAmount"]).toBe(5);
  });

  test("hash ignores drift in a mood-derived float", () => {
    // The exact pair observed drifting across a real snapshot round trip.
    const a = state([player(1, { probWilling: 0.999999966671512 })]);
    const b = state([player(1, { probWilling: 0.9999999665409729 })]);
    expect(stateHash(canonicalizeForHash(a))).toBe(
      stateHash(canonicalizeForHash(b)),
    );
  });

  test("hash ignores roster array order", () => {
    // Two players tied on `overall`: a stable sort leaves their relative order
    // decided by raw-row iteration order, which a round trip may reorder.
    const one = player(10, { overall: 64 });
    const two = player(183, { overall: 64 });
    expect(stateHash(canonicalizeForHash(state([one, two])))).toBe(
      stateHash(canonicalizeForHash(state([two, one]))),
    );
  });

  test("still distinguishes a real change to state of record", () => {
    const a = state([player(1, { overall: 50 })]);
    const b = state([player(1, { overall: 51 })]);
    expect(stateHash(canonicalizeForHash(a))).not.toBe(
      stateHash(canonicalizeForHash(b)),
    );
  });
});
