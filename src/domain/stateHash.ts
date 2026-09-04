import { createHash } from "node:crypto";

import {
  PLAYER_SUMMARY_DERIVED_FIELDS,
  type EngineRawState,
  type PlayerSummary,
} from "./types.js";

const DERIVED: ReadonlySet<string> = new Set(PLAYER_SUMMARY_DERIVED_FIELDS);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const stateHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

/**
 * Project engine state onto the fields that are state of record, dropping the
 * derived roster enrichment listed in PLAYER_SUMMARY_DERIVED_FIELDS.
 *
 * Hashing must be stable across a snapshot export/import round trip, because
 * rollback verification compares the restored hash against the pre-action one
 * and replay compares hashes across processes. The enrichment fields are
 * sourced from zengm's roster view and include mood-derived floats that are
 * not bit-reproducible across that round trip, so they cannot participate in
 * the hash. They remain fully visible to the agent in the roster view.
 */
export const canonicalizeForHash = (state: EngineRawState): EngineRawState => {
  const strip = (players: PlayerSummary[]): PlayerSummary[] =>
    players.map((player) => {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(player)) {
        if (!DERIVED.has(key)) kept[key] = value;
      }
      return kept as unknown as PlayerSummary;
    });
  // Sort by pid as well as stripping: array order is presentation, and a
  // stable sort on a tied key leaves it dependent on raw-row iteration order,
  // which a snapshot round trip does not preserve. The hash must not depend
  // on it even if a future ordering change reintroduces the instability.
  const byPid = (players: PlayerSummary[]): PlayerSummary[] =>
    [...strip(players)].sort((a, b) => a.pid - b.pid);
  return {
    ...state,
    roster: byPid(state.roster),
    freeAgents: byPid(state.freeAgents),
  };
};

/**
 * The one definition of an episode's state hash.
 *
 * Every site that compares episode state -- rollback verification, resume
 * integrity, replay -- must call this rather than hashing raw state itself,
 * or the projections drift apart and healthy episodes get quarantined.
 */
export const episodeStateHash = (
  revision: number,
  state: EngineRawState,
): string => stateHash({ revision, state: canonicalizeForHash(state) });
