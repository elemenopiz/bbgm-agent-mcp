import type {
  DraftPickSummary,
  Phase,
  PlayerRole,
  PlayerSummary,
  ProspectSummary,
  ScheduledGame,
  TeamStanding,
  TeamSummary,
  TransactionRecord,
} from "../../domain/types.js";

/**
 * Converts raw zengm database rows/values into the normalized DTOs defined
 * by src/domain/types.ts. This file has NO import of anything from the
 * zengm checkout, on purpose: it only knows about plain-object shapes
 * ("Raw*" types below, which mirror our best understanding of the pinned
 * commit's `common/types.ts` at the fields we actually use) and produces
 * domain DTOs from them. Two consequences of that:
 *
 *  1. It never needs to be told where the zengm checkout lives, and can
 *     safely be copied alongside adapter.ts/entry.ts into the zengm
 *     checkout's `.mcp-bridge/` directory for bundling (see
 *     scripts/build-engine-bridge.ts) without any relative-path breakage.
 *  2. All raw-shape assumptions are concentrated here and in compatibility.ts
 *     rather than scattered through adapter.ts, which is where to look first
 *     after bumping the pinned commit (bbgm-engine.lock.json).
 *
 * All money fields (contract amounts, payroll, salary cap, etc.) follow the
 * convention already used by the pre-existing engine-bridge/entry.ts code:
 * zengm stores money in *thousands* internally; every DTO field here is in
 * millions, so adapter.ts divides zengm amounts by 1000 on the way out and
 * multiplies by 1000 on the way in.
 */

// ---------------------------------------------------------------------------
// Phase mapping
// ---------------------------------------------------------------------------

/**
 * zengm's numeric PHASE enum at the pinned commit (src/common/constants.ts).
 * Hardcoded here (rather than imported) so this file stays zengm-import-free
 * -- see the module doc comment. If bbgm-engine.lock.json's commit is ever
 * bumped, re-verify these numbers against the new commit's PHASE object.
 */
export const ZENGM_PHASE = {
  EXPANSION_DRAFT: -2,
  FANTASY_DRAFT: -1,
  PRESEASON: 0,
  REGULAR_SEASON: 1,
  AFTER_TRADE_DEADLINE: 2,
  PLAYOFFS: 3,
  DRAFT_LOTTERY: 4,
  DRAFT: 5,
  AFTER_DRAFT: 6,
  RESIGN_PLAYERS: 7,
  FREE_AGENCY: 8,
} as const;

/**
 * Maps a zengm numeric phase to our domain Phase string.
 *
 * Two zengm phases collapse onto one domain phase each:
 *  - REGULAR_SEASON and AFTER_TRADE_DEADLINE both map to "regular_season"
 *    (AFTER_TRADE_DEADLINE is still regular-season play, just with trading
 *    disabled -- our domain model has no separate concept for that).
 *  - DRAFT and AFTER_DRAFT both map to "draft" (AFTER_DRAFT is a brief
 *    zengm-internal transitional phase between the last pick and
 *    RESIGN_PLAYERS; there is nothing for a GM to decide during it).
 *
 * EXPANSION_DRAFT and FANTASY_DRAFT have no domain equivalent and throw.
 * CreateEpisodeInput never triggers either flow (the adapter never calls
 * expansion-draft or fantasy-draft APIs), so this should be unreachable in
 * normal use; see compatibility.ts.
 */
export function phaseFromZengm(zengmPhase: number): Phase {
  switch (zengmPhase) {
    case ZENGM_PHASE.PRESEASON:
      return "preseason";
    case ZENGM_PHASE.REGULAR_SEASON:
    case ZENGM_PHASE.AFTER_TRADE_DEADLINE:
      return "regular_season";
    case ZENGM_PHASE.PLAYOFFS:
      return "playoffs";
    case ZENGM_PHASE.DRAFT_LOTTERY:
      return "draft_lottery";
    case ZENGM_PHASE.DRAFT:
    case ZENGM_PHASE.AFTER_DRAFT:
      return "draft";
    case ZENGM_PHASE.RESIGN_PLAYERS:
      return "resigning";
    case ZENGM_PHASE.FREE_AGENCY:
      return "free_agency";
    default:
      throw new Error(
        `Unsupported Basketball GM phase ${zengmPhase} (expansion/fantasy draft phases are not ` +
          "supported by this adapter -- see compatibility.ts).",
      );
  }
}

// ---------------------------------------------------------------------------
// Players / prospects
// ---------------------------------------------------------------------------

export type RawPlayerRow = {
  pid: number;
  firstName: string;
  lastName: string;
  born: { year: number };
  tid: number;
  rosterOrder: number;
  contract: { amount: number; exp: number };
  injury: { gamesRemaining: number };
  ratings: { pos: string; ovr: number; pot: number }[];
  draft?: { year: number; tid: number };
};

/**
 * zengm has no explicit "role" concept matching PlayerRole
 * (starter/rotation/bench/inactive) -- it only tracks a numeric
 * `rosterOrder` per player (see team/rosterAutoSort.basketball.ts) and
 * per-player injury status. This derives PlayerRole heuristically:
 * injured players are "inactive" regardless of roster position; otherwise
 * the first 5 roster slots are "starter", the next 3 are "rotation", the
 * rest are "bench". This mirrors typical zengm UI conventions (5 starters)
 * but is our own heuristic, not a native zengm field -- see
 * compatibility.ts.
 */
export function derivePlayerRole(
  rosterOrder: number,
  injuryGamesRemaining: number,
): PlayerRole {
  if (injuryGamesRemaining > 0) return "inactive";
  if (rosterOrder < 5) return "starter";
  if (rosterOrder < 8) return "rotation";
  return "bench";
}

export function mapPlayerToSummary(
  raw: RawPlayerRow,
  season: number,
): PlayerSummary {
  const ratings = raw.ratings.at(-1);
  if (!ratings) throw new Error(`Player ${raw.pid} has no ratings row`);
  return {
    pid: raw.pid,
    name: `${raw.firstName} ${raw.lastName}`,
    age: season - raw.born.year,
    position: ratings.pos,
    overall: ratings.ovr,
    potential: ratings.pot,
    contractAmount: raw.contract.amount / 1000,
    contractExpires: raw.contract.exp,
    injuryGamesRemaining: raw.injury.gamesRemaining,
    role: derivePlayerRole(raw.rosterOrder, raw.injury.gamesRemaining),
    rosterOrder: raw.rosterOrder,
  };
}

/**
 * Confirmed against a real run: zengm's raw `rosterOrder` field is NOT
 * guaranteed to be a clean, unique 0..n-1 sequence at every moment -- in
 * particular, a freshly drafted player can land with a `rosterOrder` that
 * duplicates an existing roster member's, which zengm apparently only
 * reconciles the next time something explicitly re-sorts the depth chart
 * (e.g. `reorderRosterDrag`), not automatically on every roster-composition
 * change. `PlayerSummary.rosterOrder` is documented (and invariant-checked,
 * see domain/invariants.ts LINEUP_VALID) as unique-per-team, so this adapter
 * must not hand raw zengm values straight through. Re-numbers every player
 * to a stable, unique 0..n-1 sequence -- ordered by their existing
 * `rosterOrder` (preserving whatever depth-chart order the team already had,
 * including one just set via `setLineup`), tie-broken by `pid` for any
 * actual duplicates -- and recomputes `role` from the corrected order.
 * Applied to every roster this adapter returns (the user's own and, via
 * `getTeamRoster`, any other team's), independent of the array's own sort
 * order (by convention, callers sort the returned array by `overall`
 * descending for display; that sort order is unrelated to the `rosterOrder`
 * field values fixed up here).
 */
export function normalizeRosterOrder(
  players: PlayerSummary[],
): PlayerSummary[] {
  const byStableOrder = [...players].sort(
    (a, b) => a.rosterOrder - b.rosterOrder || a.pid - b.pid,
  );
  const rosterOrderByPid = new Map(
    byStableOrder.map((player, index) => [player.pid, index]),
  );
  return players.map((player) => {
    const rosterOrder = rosterOrderByPid.get(player.pid) ?? player.rosterOrder;
    return {
      ...player,
      rosterOrder,
      role: derivePlayerRole(rosterOrder, player.injuryGamesRemaining),
    };
  });
}

/**
 * Maps an undrafted prospect. `scoutedOverall`/`scoutedPotential` use the
 * player's raw (non-fuzzed) ratings; real zengm applies a scouting-accuracy
 * "fuzz" to ratings shown to the user for players who haven't proven
 * themselves yet, which this does not replicate -- see compatibility.ts.
 */
export function mapProspectToSummary(
  raw: RawPlayerRow,
  season: number,
): ProspectSummary {
  const ratings = raw.ratings.at(-1);
  if (!ratings) throw new Error(`Prospect ${raw.pid} has no ratings row`);
  return {
    pid: raw.pid,
    name: `${raw.firstName} ${raw.lastName}`,
    age: season - raw.born.year,
    position: ratings.pos,
    scoutedOverall: ratings.ovr,
    scoutedPotential: ratings.pot,
    draftYear: raw.draft?.year ?? season,
  };
}

// ---------------------------------------------------------------------------
// Draft picks
// ---------------------------------------------------------------------------

export type RawDraftPickRow = {
  dpid: number;
  tid: number;
  originalTid: number;
  round: number;
  season: number | "fantasy" | "expansion";
  note?: string;
};

/**
 * zengm's DraftPick.round is a plain number (a custom league could have more
 * rounds), so preserve it rather than silently collapsing round 3+ into
 * round 2. The standard league still produces the familiar 1/2 values.
 *
 * `protection` is sourced from zengm's free-text `note` field on the pick,
 * which is not a structured protection type upstream -- best-effort only.
 */
export function mapDraftPickToSummary(
  raw: RawDraftPickRow,
  currentSeason: number,
): DraftPickSummary {
  const season = typeof raw.season === "number" ? raw.season : currentSeason;
  return {
    dpid: raw.dpid,
    season,
    round: Math.max(1, raw.round),
    originalTeamId: raw.originalTid,
    currentTeamId: raw.tid,
    ...(raw.note ? { protection: raw.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Teams / standings
// ---------------------------------------------------------------------------

export type RawTeamRow = {
  tid: number;
  region: string;
  name: string;
  abbrev: string;
  cid: number;
  did: number;
};

export type RawTeamSeasonRow = {
  tid: number;
  won: number;
  lost: number;
};

export function mapTeamSummary(params: {
  team: RawTeamRow;
  teamSeason: RawTeamSeasonRow | undefined;
  payroll: number;
  salaryCap: number;
  luxuryTaxThreshold: number;
  hardCapActive: boolean;
  minContract: number;
  maxContract: number;
  standingRank: number;
  conferenceName: string;
  divisionName: string;
}): TeamSummary {
  const {
    team,
    teamSeason,
    payroll,
    salaryCap,
    luxuryTaxThreshold,
    hardCapActive,
    minContract,
    maxContract,
    standingRank,
    conferenceName,
    divisionName,
  } = params;
  return {
    tid: team.tid,
    name: `${team.region} ${team.name}`,
    abbrev: team.abbrev,
    won: teamSeason?.won ?? 0,
    lost: teamSeason?.lost ?? 0,
    conference: conferenceName,
    division: divisionName,
    standing: standingRank,
    payroll: payroll / 1000,
    salaryCap: salaryCap / 1000,
    capSpace: (salaryCap - payroll) / 1000,
    luxuryTaxThreshold: luxuryTaxThreshold / 1000,
    hardCapActive,
    minContract: minContract / 1000,
    maxContract: maxContract / 1000,
  };
}

export type StandingsRow = {
  tid: number;
  name: string;
  abbrev: string;
  won: number;
  lost: number;
  conference: string;
  division: string;
};

/** Ranks by win% descending and computes games-behind the league leader. */
export function computeStandings(rows: StandingsRow[]): TeamStanding[] {
  const sorted = [...rows].sort((a, b) => winPct(b) - winPct(a));
  const leader = sorted[0];
  return sorted.map((row, index) => ({
    tid: row.tid,
    name: row.name,
    abbrev: row.abbrev,
    won: row.won,
    lost: row.lost,
    conference: row.conference,
    division: row.division,
    rank: index + 1,
    gamesBehind: leader
      ? (leader.won - leader.lost - (row.won - row.lost)) / 2
      : 0,
  }));
}

function winPct(row: StandingsRow): number {
  const games = row.won + row.lost;
  return games === 0 ? 0 : row.won / games;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type RawScheduleRow = {
  gid: number;
  homeTid: number;
  awayTid: number;
  day: number;
};

/** zengm's `schedule` store only ever holds unplayed games. */
export function mapScheduleGame(
  raw: RawScheduleRow,
  season: number,
): ScheduledGame {
  return {
    gid: raw.gid,
    season,
    day: raw.day,
    homeTeamId: raw.homeTid,
    awayTeamId: raw.awayTid,
    played: false,
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type RawEventRow = {
  eid: number;
  type: string;
  // Confirmed against the real engine (and the pinned commit's own
  // EventBBGMWithoutKey union in common/types.ts): `text` is only mandatory
  // for the generic/legacy event shape. Modern "trade"/"freeAgent"/
  // "reSigned" events carry NO `text` at all -- treating it as always
  // present crashed a real getRawState() call the first time a trade/sign
  // event was in the log (`Cannot read properties of undefined (reading
  // 'replaceAll')`). See compatibility.ts.
  text?: string;
  season: number;
  tids?: number[];
  pids?: number[];
};

const EVENT_TYPE_TO_TRANSACTION_TYPE: Record<
  string,
  TransactionRecord["type"] | undefined
> = {
  draft: "draft",
  release: "release",
  freeAgent: "sign",
  reSigned: "contract_extension",
  trade: "trade",
};

/**
 * zengm's `events` store does not retain a day-of-season for each event,
 * only `season` -- so `day` is not populated here (defaulted to 0). See
 * compatibility.ts.
 */
export function mapTransactionRecord(
  raw: RawEventRow,
): TransactionRecord | undefined {
  const type = EVENT_TYPE_TO_TRANSACTION_TYPE[raw.type];
  if (!type) return undefined;
  return {
    transactionId: raw.eid,
    season: raw.season,
    day: 0,
    type,
    description: describeTransaction(raw, type),
    teamIds: raw.tids ?? [],
  };
}

/**
 * `text` (when present) is zengm's own web-UI description, embedding HTML
 * anchor tags -- stripped down to plain text. When absent (the normal case
 * for modern trade/freeAgent/reSigned events, which carry no `text` field
 * at all), a plain description is synthesized from the structured fields
 * instead, rather than crashing or returning an empty string.
 */
function describeTransaction(
  raw: RawEventRow,
  type: TransactionRecord["type"],
): string {
  if (raw.text) return stripHtml(raw.text);
  const pid = raw.pids?.[0];
  switch (type) {
    case "trade":
      return `Trade between team(s) ${raw.tids?.join(" and ") ?? "unknown"}`;
    case "sign":
      return pid !== undefined
        ? `Signed free agent (player ${pid})`
        : "Signed a free agent";
    case "contract_extension":
      return pid !== undefined
        ? `Re-signed player ${pid}`
        : "Re-signed a player";
    case "release":
      return pid !== undefined ? `Released player ${pid}` : "Released a player";
    case "draft":
      return pid !== undefined ? `Drafted player ${pid}` : "Made a draft pick";
  }
}

function stripHtml(text: string): string {
  return text.replaceAll(/<[^>]*>/g, "").trim();
}
