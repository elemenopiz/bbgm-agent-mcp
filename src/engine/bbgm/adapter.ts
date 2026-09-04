import type {
  AdvanceInput,
  AdvertiseOnTradingBlockInput,
  CreateEpisodeInput,
  EngineEvent,
  EmploymentStatus,
  EngineOption,
  EngineRawState,
  MakeDraftPickInput,
  NegotiateContractInput,
  PlayerAward,
  PlayerContractYear,
  PlayerDetail,
  PlayerDraftInfo,
  PlayerInjuryHistoryEntry,
  PlayerRatingsSeason,
  PlayerStatsSeason,
  PlayerSummary,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeAsset,
  TradeEvaluation,
  TradeOffer,
  TradeOfferAsset,
  TradeProposal,
  TradeProposalsData,
  TradingBlockData,
} from "../../domain/types.js";

import {
  computeStandings,
  mapDraftPickToSummary,
  mapPlayerToSummary,
  mapProspectToSummary,
  mapScheduleGame,
  mapTeamSummary,
  mapTransactionRecord,
  normalizeRosterOrder,
  phaseFromZengm,
  ZENGM_PHASE,
  type RawDraftPickRow,
  type RawEventRow,
  type RawPlayerRow,
  type RawScheduleRow,
  type RawTeamRow,
  type RawTeamSeasonRow,
} from "./mappings.js";

// ---------------------------------------------------------------------------
// Compatibility boundary: shape of the (already dynamically-imported) zengm
// modules this adapter needs. engine-bridge/entry.ts performs the actual
// `import("../src/worker/...")` calls (after bootstrap.ts installs worker
// globals) and passes the results in here as plain objects -- this file has
// no static import of anything inside the zengm checkout, which is what
// lets it be copied and bundled alongside entry.ts regardless of where
// BBGM_SOURCE_DIR points (see scripts/build-engine-bridge.ts).
//
// Per project rule 5 ("no `any` except a tightly-scoped, documented upstream
// compatibility boundary"), this block is that boundary. Fields are typed as
// concretely as we could confirm against the pinned commit (see
// compatibility.ts for confidence notes on individual call sites); anything
// not directly exercised is left as `unknown`/a minimal call signature
// rather than `any`.
// ---------------------------------------------------------------------------

export type ZengmConditions = Record<string, unknown>;

/**
 * The upstream negotiation preflight can reject a free-agent offer before it
 * mutates IndexedDB (for example, when the player is unwilling). Marking that
 * fact lets DomainService preserve the audit record without repeatedly
 * importing a full league snapshot, which otherwise grows the in-memory
 * IndexedDB heap during long baseline runs.
 */
class EngineActionRejectedError extends Error {
  readonly code = "ILLEGAL_ACTION";
  readonly retryable = false;
  readonly rollbackRequired = false;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "EngineActionRejectedError";
    this.details = details;
  }
}

export type ZengmTradeTeam = { tid: number; pids: number[]; dpids: number[] };
export type ZengmTradeTeams = [ZengmTradeTeam, ZengmTradeTeam];

type StoreApi<T> = {
  get: (id: number) => Promise<T | undefined>;
  getAll: () => Promise<T[]>;
  indexGet: (index: string, key: unknown) => Promise<T | undefined>;
  indexGetAll: (index: string, key: unknown) => Promise<T[]>;
  add: (obj: unknown) => Promise<number>;
  put: (obj: unknown) => Promise<number>;
  delete: (id: number) => Promise<void>;
  clear: () => Promise<void>;
};

type ZengmNegotiation = { pid: number; tid: number; resigning: boolean };

export type ZengmModules = {
  /** zengm's own curated worker views (src/worker/views). Preferred source
   * for player information: raw IndexedDB rows carry no mood, ratings deltas,
   * skills or stats. See docs/INFORMATION_AUDIT.md. */
  views?: {
    roster: (inputs: {
      tid: number;
      season: number;
      playoffs: "regularSeason" | "playoffs" | "combined";
    }) => Promise<unknown>;
    /** zengm's player-detail worker view (src/worker/views/player.ts).
     * Returns the full ratings/stats/contract/award/injury history for one
     * player -- this is what bbgm_get_player maps from. See getPlayer()
     * below. */
    player?: (inputs: { pid: number }) => Promise<unknown>;
    /** zengm's trading-block worker view (src/worker/views/tradingBlock.ts).
     * Called with no pids/dpids so it reads back whatever is currently saved
     * (savedTradingBlock) rather than previewing a candidate advertisement --
     * this is what bbgm_get_state(view="trading_block") maps from. See
     * getTradingBlock() below. */
    tradingBlock?: (inputs: {
      pids?: number[];
      dpids?: number[];
    }) => Promise<unknown>;
    /** zengm's trade-proposals worker view (src/worker/views/tradeProposals.ts).
     * Returns up to 5 AI-initiated offers the user did not solicit -- this is
     * what bbgm_get_state(view="trade_proposals") maps from. See
     * getTradeProposals() below. */
    tradeProposals?: (inputs?: unknown) => Promise<unknown>;
  };
  core: {
    player: {
      setContract: (
        p: RawPlayerRow,
        contract: { amount: number; exp: number },
        signed: boolean,
      ) => void;
    };
    contractNegotiation: {
      create: (
        pid: number,
        resigning: boolean,
        tid?: number,
      ) => Promise<{ pid: number; tid: number; resigning: boolean } | string>;
    };
    trade: {
      summary: (teams: ZengmTradeTeams) => Promise<{
        warning: string | null;
        teams: [
          { payrollBeforeTrade: number; payrollAfterTrade: number },
          { payrollBeforeTrade: number; payrollAfterTrade: number },
        ];
      }>;
    };
    team: {
      getPayroll: (tid: number) => Promise<number>;
      ValueChangeCalculator: new () => {
        evaluate: (params: {
          tid: number;
          pidsAdd: number[];
          pidsRemove: number[];
          dpidsAdd: number[];
          dpidsRemove: number[];
          tradingPartnerTid: number;
        }) => Promise<number>;
      };
    };
    draft: {
      getOrder: () => Promise<RawDraftPickRow[]>;
    };
    league: {
      createStream: (
        stream: unknown,
        options: Record<string, unknown>,
      ) => Promise<void>;
      close: (removeFromDb: boolean) => Promise<void>;
      remove: (lid: number) => Promise<void>;
    };
    phase: {
      newPhase: (
        phase: number,
        conditions: ZengmConditions,
        extra?: unknown,
      ) => Promise<void>;
    };
  };
  db: {
    idb: {
      cache: {
        players: StoreApi<RawPlayerRow>;
        teams: StoreApi<RawTeamRow>;
        teamSeasons: StoreApi<RawTeamSeasonRow>;
        draftPicks: StoreApi<RawDraftPickRow>;
        schedule: StoreApi<RawScheduleRow>;
        events: StoreApi<RawEventRow>;
        negotiations: StoreApi<ZengmNegotiation>;
        trade: StoreApi<{ rid: number; teams: ZengmTradeTeams }>;
        flush: () => Promise<void>;
      };
      league:
        | {
            objectStoreNames: Iterable<string>;
            transaction: (storeNames: string[]) => IdbTransactionLike;
          }
        | undefined;
      meta: {
        put: (
          storeName: "leagues",
          value: ZengmLeagueMetadata,
        ) => Promise<unknown>;
        close: () => Promise<void>;
      };
    };
    connectLeague: (lid: number) => Promise<{
      transaction: (
        storeNames: string[],
        mode: "readwrite",
      ) => IdbTransactionLike;
      close: () => void;
    }>;
  };
  util: {
    g: { get: (key: string) => unknown };
    lock: { get: (name: "gameSim" | "newPhase") => boolean };
    helpers: {
      addPopRank: (teams: unknown[]) => unknown[];
      getTeamsDefault: () => unknown[];
    };
  };
  api: {
    // Confirmed against a real run: only these seven categories
    // (actions/eightyTwoZeroDraft/exhibitionGame/leagueFileUpload/
    // playMenu/toolsMenu/undoLog) are top-level on the real `api` default
    // export (src/worker/api/index.ts). Everything else -- including every
    // other function this adapter calls -- is nested one level deeper,
    // under `api.main.*`. The original version of this type had
    // releasePlayer/reorderRosterDrag/draftUser/acceptContractNegotiation/
    // createTrade/proposeTrade all as top-level `api.*`, which crashed a
    // real makeDraftPick() call with "api.draftUser is not a function" --
    // fixed here, not guessed.
    playMenu: Record<
      string,
      (param: unknown, conditions: ZengmConditions) => Promise<void>
    >;
    main: {
      releasePlayer: (params: {
        pids: number[];
      }) => Promise<string | undefined>;
      reorderRosterDrag: (sortedPids: number[]) => Promise<void>;
      draftUser: (pid: number, conditions: ZengmConditions) => Promise<void>;
      acceptContractNegotiation: (params: {
        pid: number;
        amount: number;
        exp: number;
      }) => Promise<string | number | undefined>;
      createTrade: (teams: ZengmTradeTeams) => Promise<void>;
      proposeTrade: (
        forceTrade: boolean,
        conditions: ZengmConditions,
      ) => Promise<{ accepted: boolean; message: string | null }>;
      /** Computes AI counter-offers for a candidate trading-block
       * advertisement AND persists it as the user's saved trading block
       * (idb.cache.savedTradingBlock) -- the same function the real UI's
       * "Ask For Trade Proposals" button calls (api/index.ts's
       * getTradingBlockOffers). `lookingFor` is zengm's optional
       * position/skill/asset preference filter; an all-false/empty value
       * (this adapter's default) matches upstream's own "no preference"
       * initial state and applies no filtering. See
       * advertiseOnTradingBlock() below. */
      getTradingBlockOffers: (params: {
        pids: number[];
        dpids: number[];
        lookingFor: unknown;
      }) => Promise<unknown[]>;
    };
  };
  constants: {
    PHASE: Record<string, number>;
    PLAYER: Record<string, number>;
    LEAGUE_DATABASE_VERSION: number;
  };
  defaultGameAttributes: Record<string, { start: number; value: unknown }[]>;
  utils: { last: <T>(array: T[]) => T };
  newLeague: { getDefaultSettings: () => Record<string, unknown> };
  createStreamFromLeagueObject: (
    leagueObject: Record<string, unknown>,
  ) => unknown;
  beforeView: {
    beforeLeague: (
      lid: number,
      params: Record<string, unknown>,
    ) => Promise<void>;
  };
};

/** Minimal shape of the browser IDBTransaction-like object exportSnapshot/importSnapshot use. */
type IdbTransactionLike = {
  objectStore: (name: string) => {
    getAll: () => Promise<unknown[]>;
    clear: () => Promise<void>;
    put: (value: unknown) => Promise<unknown>;
  };
  done: Promise<void>;
};

type SnapshotRow = Record<string, unknown>;

type LeagueSnapshot = {
  lid: number;
  data: Record<string, unknown[]>;
};

type ZengmLeagueMetadata = {
  lid: number;
  name: string;
  tid: number;
  phaseText: string;
  teamName: string;
  teamRegion: string;
  difficulty?: number;
  created: Date;
  lastPlayed: Date;
  startingSeason?: number;
  season?: number;
  imgURL?: string;
};

const isRecord = (value: unknown): value is SnapshotRow =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const parseLeagueSnapshot = (snapshot: unknown): LeagueSnapshot => {
  if (!isRecord(snapshot) || !Number.isSafeInteger(snapshot["lid"])) {
    throw new Error("Basketball GM snapshot is missing a valid league id");
  }
  if (!isRecord(snapshot["data"])) {
    throw new Error("Basketball GM snapshot is missing league data");
  }

  const data: Record<string, unknown[]> = {};
  for (const [storeName, rows] of Object.entries(snapshot["data"])) {
    if (!Array.isArray(rows)) {
      throw new Error(
        `Basketball GM snapshot store ${storeName} must contain an array`,
      );
    }
    data[storeName] = rows;
  }
  return { lid: snapshot["lid"] as number, data };
};

const snapshotAttribute = (
  data: Record<string, unknown[]>,
  key: string,
): unknown => {
  const row = data["gameAttributes"]?.find(
    (candidate) => isRecord(candidate) && candidate["key"] === key,
  );
  if (!isRecord(row)) return undefined;

  const value = row["value"];
  if (
    isUnknownArray(value) &&
    value.length > 0 &&
    isRecord(value[0]) &&
    "start" in value[0] &&
    "value" in value[0]
  ) {
    const last = value.at(-1);
    return isRecord(last) ? last["value"] : undefined;
  }
  return value;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const leagueMetadataFromSnapshot = (
  snapshot: LeagueSnapshot,
): ZengmLeagueMetadata => {
  const tid = finiteNumber(snapshotAttribute(snapshot.data, "userTid"));
  if (tid === undefined || !Number.isSafeInteger(tid)) {
    throw new Error(
      "Basketball GM snapshot is missing a numeric userTid game attribute",
    );
  }

  const teams = snapshot.data["teams"] ?? [];
  const team = teams.find(
    (candidate) => isRecord(candidate) && candidate["tid"] === tid,
  );
  const teamName =
    isRecord(team) && typeof team["name"] === "string"
      ? team["name"]
      : `Team ${tid}`;
  const teamRegion =
    isRecord(team) && typeof team["region"] === "string" ? team["region"] : "";

  const metadata: ZengmLeagueMetadata = {
    lid: snapshot.lid,
    name: `MCP restored league ${snapshot.lid}`,
    tid,
    phaseText: "",
    teamName,
    teamRegion,
    created: new Date(),
    lastPlayed: new Date(),
  };
  const difficulty = finiteNumber(
    snapshotAttribute(snapshot.data, "difficulty"),
  );
  const season = finiteNumber(snapshotAttribute(snapshot.data, "season"));
  const startingSeason = finiteNumber(
    snapshotAttribute(snapshot.data, "startingSeason"),
  );
  const imgURL =
    isRecord(team) && typeof team["imgURL"] === "string"
      ? team["imgURL"]
      : undefined;
  if (difficulty !== undefined) metadata.difficulty = difficulty;
  if (season !== undefined) metadata.season = season;
  if (startingSeason !== undefined) metadata.startingSeason = startingSeason;
  if (imgURL !== undefined) metadata.imgURL = imgURL;
  return metadata;
};

// ---------------------------------------------------------------------------
// Trading block / trade proposals mapping. Sourced from zengm's own
// tradingBlock/tradeProposals worker views (view-shaped playersPlus /
// draftPicks-with-desc / augmented-offer objects), not raw IndexedDB rows --
// see docs/INFORMATION_AUDIT.md and getTradingBlock()/getTradeProposals()
// below. Maps defensively: every field optional, unknown shapes degrade to
// `undefined`/an empty list rather than throwing. Deliberately excludes
// zengm's internal `value` composite valuation, same as getPlayer() above.
// ---------------------------------------------------------------------------

/** A single view-shaped player (playersPlus output: attrs pid/firstName/
 * lastName/age/contract/untradable, ratings ovr/pot/skills/pos). Contract
 * amounts here are already millions -- playersPlus converts them, unlike
 * rosterEnrichment's raw mood.contractAmount; see getPlayer()'s doc comment. */
function mapViewPlayerToOfferAsset(raw: unknown): TradeOfferAsset | undefined {
  if (!isRecord(raw) || typeof raw["pid"] !== "number") return undefined;
  const ratings = isRecord(raw["ratings"]) ? raw["ratings"] : undefined;
  const contract = isRecord(raw["contract"]) ? raw["contract"] : undefined;
  const asset: Extract<TradeOfferAsset, { type: "player" }> = {
    type: "player",
    pid: raw["pid"],
  };
  if (
    typeof raw["firstName"] === "string" &&
    typeof raw["lastName"] === "string"
  )
    asset.name = `${raw["firstName"]} ${raw["lastName"]}`;
  if (typeof raw["age"] === "number") asset.age = raw["age"];
  if (typeof ratings?.["pos"] === "string") asset.position = ratings["pos"];
  if (typeof ratings?.["ovr"] === "number") asset.overall = ratings["ovr"];
  if (typeof ratings?.["pot"] === "number") asset.potential = ratings["pot"];
  if (typeof contract?.["amount"] === "number")
    asset.contractAmount = contract["amount"];
  if (typeof contract?.["exp"] === "number")
    asset.contractExpires = contract["exp"];
  if (Array.isArray(ratings?.["skills"]))
    asset.skills = ratings["skills"].filter(
      (skill): skill is string => typeof skill === "string",
    );
  if (typeof raw["untradable"] === "boolean")
    asset.untradable = raw["untradable"];
  return asset;
}

/** A single view-shaped draft pick (zengm's raw pick fields plus a
 * human-readable `desc` added by helpers.pickDesc). */
function mapViewPickToOfferAsset(raw: unknown): TradeOfferAsset | undefined {
  if (!isRecord(raw) || typeof raw["dpid"] !== "number") return undefined;
  const asset: Extract<TradeOfferAsset, { type: "draft_pick" }> = {
    type: "draft_pick",
    dpid: raw["dpid"],
  };
  if (typeof raw["season"] === "number") asset.season = raw["season"];
  if (typeof raw["round"] === "number") asset.round = raw["round"];
  if (typeof raw["desc"] === "string") asset.description = raw["desc"];
  return asset;
}

const finitePayrollThousands = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value / 1000
    : undefined;

/**
 * One augmented offer object shared by tradingBlock's savedTradingBlock.offers
 * and tradeProposals' offers (api/index.ts's augmentOffers): {tid, strategy,
 * won, lost, payroll, pids, dpids, pidsUser, dpidsUser, players, picks,
 * playersUser, picksUser, willing?}. Oriented like TradeProposal: `players`/
 * `picks` (the other team's side) become `requested`; `playersUser`/
 * `picksUser` (the user's side) become `offered` -- see TradeOffer's doc
 * comment.
 */
function mapRawTradeOffer(raw: unknown): TradeOffer | undefined {
  if (!isRecord(raw) || typeof raw["tid"] !== "number") return undefined;
  const offer: TradeOffer = {
    otherTeamId: raw["tid"],
    offered: [],
    requested: [],
  };
  if (typeof raw["strategy"] === "string") offer.strategy = raw["strategy"];
  if (typeof raw["won"] === "number") offer.won = raw["won"];
  if (typeof raw["lost"] === "number") offer.lost = raw["lost"];
  const payroll = finitePayrollThousands(raw["payroll"]);
  if (payroll !== undefined) offer.payroll = payroll;
  if (typeof raw["willing"] === "boolean") offer.willing = raw["willing"];

  const requestedPlayers = Array.isArray(raw["players"]) ? raw["players"] : [];
  const requestedPicks = Array.isArray(raw["picks"]) ? raw["picks"] : [];
  const offeredPlayers = Array.isArray(raw["playersUser"])
    ? raw["playersUser"]
    : [];
  const offeredPicks = Array.isArray(raw["picksUser"]) ? raw["picksUser"] : [];

  offer.requested = [
    ...requestedPlayers.map(mapViewPlayerToOfferAsset),
    ...requestedPicks.map(mapViewPickToOfferAsset),
  ].filter((asset): asset is TradeOfferAsset => asset !== undefined);
  offer.offered = [
    ...offeredPlayers.map(mapViewPlayerToOfferAsset),
    ...offeredPicks.map(mapViewPickToOfferAsset),
  ].filter((asset): asset is TradeOfferAsset => asset !== undefined);

  return offer;
}

const rawTid = (raw: unknown): number =>
  isRecord(raw) && typeof raw["tid"] === "number" ? raw["tid"] : 0;

/** Deterministic ordering: sort raw offers by team ID ascending before
 * mapping, rather than trusting the engine's own (seed-shuffled) team
 * iteration order -- see docs/INFORMATION_AUDIT.md's reproducibility note. */
function mapAndSortOffers(rawOffers: unknown[]): TradeOffer[] {
  return [...rawOffers]
    .sort((a, b) => rawTid(a) - rawTid(b))
    .map(mapRawTradeOffer)
    .filter((offer): offer is TradeOffer => offer !== undefined);
}

const rawPlayerOverall = (raw: unknown): number =>
  isRecord(raw) &&
  isRecord(raw["ratings"]) &&
  typeof raw["ratings"]["ovr"] === "number"
    ? raw["ratings"]["ovr"]
    : 0;

function mapAndSortTradableRoster(rawPlayers: unknown[]): TradeOfferAsset[] {
  return [...rawPlayers]
    .sort((a, b) => rawPlayerOverall(b) - rawPlayerOverall(a))
    .map(mapViewPlayerToOfferAsset)
    .filter((asset): asset is TradeOfferAsset => asset !== undefined);
}

const rawPickSortKey = (raw: unknown): [number, number, number] =>
  isRecord(raw)
    ? [
        typeof raw["season"] === "number" ? raw["season"] : 0,
        typeof raw["round"] === "number" ? raw["round"] : 0,
        typeof raw["dpid"] === "number" ? raw["dpid"] : 0,
      ]
    : [0, 0, 0];

function mapAndSortTradablePicks(rawPicks: unknown[]): TradeOfferAsset[] {
  return [...rawPicks]
    .sort((a, b) => {
      const [seasonA, roundA, dpidA] = rawPickSortKey(a);
      const [seasonB, roundB, dpidB] = rawPickSortKey(b);
      return seasonA - seasonB || roundA - roundB || dpidA - dpidB;
    })
    .map(mapViewPickToOfferAsset)
    .filter((asset): asset is TradeOfferAsset => asset !== undefined);
}

/** Neutral "no preference" filter for api.main.getTradingBlockOffers,
 * matching upstream's own useLookingForState() initial state (every
 * position/skill/asset toggle false). Upstream's getTradingBlockOffers
 * treats an all-false value as "apply no filtering, don't save a
 * preference" (api/index.ts's toConciseLookingFor); using empty
 * positions/skills objects works for any sport without hardcoding
 * basketball-specific position/skill keys. */
const NEUTRAL_LOOKING_FOR = {
  positions: {},
  skills: {},
  assets: { draftPicks: false, prospects: false, bestCurrentPlayers: false },
};

export type BasketballGmAdapter = {
  create(input: CreateEpisodeInput): Promise<void>;
  getRawState(): Promise<EngineRawState>;
  getTeamRoster(params: { tid: number }): Promise<PlayerSummary[]>;
  getPlayer(params: { pid: number }): Promise<PlayerDetail>;
  getOptions(): Promise<EngineOption[]>;
  evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation>;
  getTradingBlock(): Promise<TradingBlockData>;
  getTradeProposals(): Promise<TradeProposalsData>;
  executeTrade(proposal: TradeProposal): Promise<EngineEvent[]>;
  advertiseOnTradingBlock(
    input: AdvertiseOnTradingBlockInput,
  ): Promise<EngineEvent[]>;
  setLineup(input: SetLineupInput): Promise<EngineEvent[]>;
  releasePlayer(input: ReleasePlayerInput): Promise<EngineEvent[]>;
  negotiateContract(input: NegotiateContractInput): Promise<EngineEvent[]>;
  signFreeAgent(input: SignFreeAgentInput): Promise<EngineEvent[]>;
  makeDraftPick(input: MakeDraftPickInput): Promise<EngineEvent[]>;
  advance(input: AdvanceInput): Promise<EngineEvent[]>;
  exportSnapshot(): Promise<unknown>;
  importSnapshot(snapshot: unknown): Promise<void>;
  close(): Promise<void>;
};

const MAX_ADVANCE_STEPS = 400;

/**
 * One zengm phase-appropriate "step" per phase -- see compatibility.ts
 * ("advance() decision points"). RESIGN_PLAYERS is deliberately absent:
 * see stepOneZengmPhase's special-case for it, and compatibility.ts
 * ("playMenu.untilFreeAgency confirm gate").
 */
const PHASE_STEP_ACTION: Record<number, string> = {
  [ZENGM_PHASE.PRESEASON]: "untilRegularSeason",
  [ZENGM_PHASE.REGULAR_SEASON]: "day",
  [ZENGM_PHASE.AFTER_TRADE_DEADLINE]: "day",
  [ZENGM_PHASE.PLAYOFFS]: "day",
  [ZENGM_PHASE.DRAFT_LOTTERY]: "untilDraft",
  [ZENGM_PHASE.DRAFT]: "untilYourNextPick",
  [ZENGM_PHASE.AFTER_DRAFT]: "untilResignPlayers",
  [ZENGM_PHASE.FREE_AGENCY]: "day",
};

/**
 * Direct mappings for the meaningful time controls exposed by Basketball GM's
 * play menu. The existing phase-step loop remains the default for
 * next_decision/phase/season_end because it can stop at the wrapper's explicit
 * decision boundaries. These controls mirror upstream's bounded UI actions;
 * they never choose a player or silently complete a user's draft pick.
 */
const PLAY_MENU_TARGET_ACTION: Partial<Record<AdvanceInput["target"], string>> =
  {
    week: "week",
    month: "month",
    one_pick: "onePick",
    until_all_star_game: "untilAllStarGame",
    until_trade_deadline: "untilTradeDeadline",
    until_playoffs: "untilPlayoffs",
    until_end_of_round: "untilEndOfRound",
    until_end_of_play_in: "untilEndOfPlayIn",
    through_playoffs: "throughPlayoffs",
    until_draft: "untilDraft",
    until_next_pick: "untilYourNextPick",
    until_resign_players: "untilResignPlayers",
    until_free_agency: "untilFreeAgency",
    until_preseason: "untilPreseason",
    until_regular_season: "untilRegularSeason",
  };

const MILESTONE_MINIMUM_PHASE: Partial<Record<AdvanceInput["target"], number>> =
  {
    until_preseason: ZENGM_PHASE.PRESEASON,
    until_playoffs: ZENGM_PHASE.PLAYOFFS,
    until_draft: ZENGM_PHASE.DRAFT,
    until_resign_players: ZENGM_PHASE.RESIGN_PLAYERS,
    until_free_agency: ZENGM_PHASE.FREE_AGENCY,
    until_regular_season: ZENGM_PHASE.REGULAR_SEASON,
  };

export function createBasketballGmAdapter(
  zengm: ZengmModules,
): BasketballGmAdapter {
  const { core, db, util, api, constants } = zengm;
  const { idb } = db;
  const { g } = util;
  const conditions: ZengmConditions = {};

  let created = false;
  const requireCreated = (): void => {
    if (!created)
      throw new Error(
        "Basketball GM adapter: create() has not been called for this worker yet",
      );
  };

  const userTid = (): number => g.get("userTid") as number;
  const season = (): number => g.get("season") as number;
  const phaseNum = (): number => g.get("phase") as number;

  /**
   * BBGM's gameOver attribute is the authoritative employment boundary for
   * this study. It is not present in every engine state (notably immediately
   * after league creation), so unsupported/absent values remain undefined and
   * are surfaced as an unknown status by higher layers.
   */
  const employmentStatus = (): EmploymentStatus | undefined => {
    try {
      const gameOver = g.get("gameOver");
      if (gameOver === true || gameOver === "fired") return "fired";
      if (gameOver === false || gameOver === "employed") return "employed";
    } catch {
      // g.get throws when the optional attribute has not been initialized.
    }
    return undefined;
  };

  const currentDay = (): number | undefined => {
    try {
      return g.get("day") as number;
    } catch {
      return undefined;
    }
  };

  const cumulativeUserRecord = async (
    tid: number,
  ): Promise<{ won: number; lost: number } | undefined> => {
    await idb.cache.flush();
    const league = idb.league;
    if (!league) return undefined;
    const transaction = league.transaction(["teamSeasons"]);
    const rows = await transaction.objectStore("teamSeasons").getAll();
    await transaction.done;

    let won = 0;
    let lost = 0;
    for (const row of rows) {
      if (!isRecord(row) || row["tid"] !== tid) continue;
      if (typeof row["won"] === "number") won += row["won"];
      if (typeof row["lost"] === "number") lost += row["lost"];
    }
    return { won, lost };
  };

  // -- shared read helpers ---------------------------------------------------

  const getConferenceDivisionNames = (): {
    confName: Map<number, string>;
    divName: Map<number, string>;
  } => {
    const confs = (g.get("confs") as { cid: number; name: string }[]) ?? [];
    const divs =
      (g.get("divs") as { did: number; cid: number; name: string }[]) ?? [];
    return {
      confName: new Map(confs.map((c) => [c.cid, c.name])),
      divName: new Map(divs.map((d) => [d.did, d.name])),
    };
  };

  const getUserGamesPlayed = async (): Promise<number> => {
    const ts = await idb.cache.teamSeasons.indexGet("teamSeasonsByTidSeason", [
      userTid(),
      season(),
    ]);
    return (ts?.won ?? 0) + (ts?.lost ?? 0);
  };

  const isBlockedOnUserDraftPick = async (): Promise<boolean> => {
    if (phaseNum() !== ZENGM_PHASE.DRAFT) return false;
    const order = await core.draft.getOrder();
    const next = order[0];
    return next?.tid === userTid();
  };

  const hasPendingResigningNegotiations = async (): Promise<boolean> => {
    if (phaseNum() !== ZENGM_PHASE.RESIGN_PLAYERS) return false;
    await idb.cache.flush();
    const negotiations = await idb.cache.negotiations.getAll();
    for (const negotiation of negotiations) {
      if (negotiation.tid !== userTid() || !negotiation.resigning) continue;
      // The upstream phase transition can retain a stale resigning row after
      // the player has already become a free agent. Such a row is not a
      // decision the user can legally resolve, so it must not deadlock the
      // milestone controller.
      const player = await idb.cache.players.get(negotiation.pid);
      if (player?.tid === userTid()) return true;
    }
    return false;
  };

  const isBlockedOnUserDecision = async (): Promise<boolean> =>
    (await isBlockedOnUserDraftPick()) ||
    (await hasPendingResigningNegotiations());

  const waitForUpstreamSimulation = async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    let idlePolls = 0;
    while (util.lock.get("gameSim")) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Basketball GM milestone simulation did not become idle within 60 seconds",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // BBGM clears gameSim immediately before cbNoGames starts a final phase
    // transition. Require two consecutive idle turns so we do not read the
    // league between those operations.
    while (idlePolls < 2 || util.lock.get("newPhase")) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Basketball GM milestone phase transition did not become idle within 60 seconds",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!util.lock.get("gameSim") && !util.lock.get("newPhase")) {
        idlePolls += 1;
      } else {
        idlePolls = 0;
      }
    }
    await idb.cache.flush();
  };

  const milestoneReached = async (
    target: AdvanceInput["target"],
    seasonBefore: number,
  ): Promise<boolean> => {
    const phase = phaseNum();
    switch (target) {
      case "until_all_star_game":
        // The public state model does not expose the special-game day. The
        // upstream play-menu call is authoritative when it advances the day;
        // a phase transition past the regular season is also unambiguous.
        return phase > ZENGM_PHASE.REGULAR_SEASON;
      case "until_trade_deadline":
        return phase >= ZENGM_PHASE.AFTER_TRADE_DEADLINE;
      case "until_playoffs":
        return phase >= ZENGM_PHASE.PLAYOFFS;
      case "until_end_of_round":
      case "until_end_of_play_in":
        return phase > ZENGM_PHASE.PLAYOFFS;
      case "through_playoffs":
        return phase > ZENGM_PHASE.PLAYOFFS || season() > seasonBefore;
      case "until_draft":
        return phase >= ZENGM_PHASE.DRAFT;
      case "until_next_pick":
        return await isBlockedOnUserDraftPick();
      case "until_resign_players":
        return phase >= ZENGM_PHASE.RESIGN_PLAYERS;
      case "until_free_agency":
        return phase >= ZENGM_PHASE.FREE_AGENCY;
      case "until_preseason":
        return phase >= ZENGM_PHASE.PRESEASON;
      case "until_regular_season":
        return phase >= ZENGM_PHASE.REGULAR_SEASON;
      case "week":
      case "month":
      case "one_pick":
        // These are direct upstream play-menu operations. A no-op is still
        // a valid human-facing action in a phase where the upstream menu does
        // not advance (for example, while waiting for a draft pick).
        return true;
      default:
        return false;
    }
  };

  const advanceByPhaseStepsUntilMilestone = async (
    target: AdvanceInput["target"],
    seasonBefore: number,
  ): Promise<EngineEvent[]> => {
    for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
      if (await milestoneReached(target, seasonBefore)) {
        return [
          {
            type: "advance_complete",
            reason: `completed_${target}_fallback`,
          },
        ];
      }
      if (await isBlockedOnUserDecision()) {
        return [
          { type: "advance_complete", reason: "blocked_pending_decision" },
        ];
      }
      await stepOneZengmPhase();
      await waitForUpstreamSimulation();
    }
    return [{ type: "advance_complete", reason: "hit_step_limit" }];
  };

  const assertMilestoneReached = async (
    target: AdvanceInput["target"],
    seasonBefore: number,
    phaseBefore: number,
    dayBefore: number | undefined,
  ): Promise<boolean> => {
    const minimumPhase = MILESTONE_MINIMUM_PHASE[target];
    const dayAfter = currentDay();
    const reached = await milestoneReached(target, seasonBefore);
    const progressed =
      season() > seasonBefore ||
      phaseNum() !== phaseBefore ||
      (dayAfter !== undefined &&
        dayBefore !== undefined &&
        dayAfter > dayBefore);
    return reached || (minimumPhase === undefined && progressed);
  };

  const stepOneZengmPhase = async (): Promise<void> => {
    if (phaseNum() === ZENGM_PHASE.RESIGN_PLAYERS) {
      // Confirmed against a real run: api.playMenu.untilFreeAgency only
      // transitions to FREE_AGENCY after `await toUI("confirm", [...])`
      // resolves truthy, which -- under NODE_ENV="test" (see bootstrap.ts)
      // -- toUI() short-circuits to `Promise.resolve()`, i.e. `undefined`,
      // i.e. falsy. So playMenu.untilFreeAgency silently never advances the
      // phase whenever any resign-window negotiations are still pending,
      // which is the common case, and advance() would report
      // "hit_step_limit" forever instead of making progress. This calls
      // the real underlying phase transition directly instead, the same
      // one playMenu.untilFreeAgency would have called had the (headless,
      // unanswerable) confirm dialog been accepted -- functionally
      // equivalent to a human clicking "Proceed" on that dialog. See
      // compatibility.ts.
      await core.phase.newPhase(ZENGM_PHASE.FREE_AGENCY, conditions);
      return;
    }
    const action = PHASE_STEP_ACTION[phaseNum()];
    if (!action) {
      throw new Error(
        `Basketball GM adapter: no advance() step defined for zengm phase ${phaseNum()} ` +
          "(expansion/fantasy draft phases are unsupported -- see compatibility.ts)",
      );
    }
    const fn = api.playMenu[action];
    if (!fn)
      throw new Error(
        `Basketball GM adapter: api.playMenu.${action} was not found on the imported zengm module`,
      );
    await fn(undefined, conditions);
  };

  const nextDecisionLabel = async (): Promise<string> => {
    if (await isBlockedOnUserDraftPick()) return "make_draft_pick";
    if (await hasPendingResigningNegotiations()) return "negotiate_contract";
    const phase = phaseNum();
    if (
      phase === ZENGM_PHASE.REGULAR_SEASON ||
      phase === ZENGM_PHASE.AFTER_TRADE_DEADLINE ||
      phase === ZENGM_PHASE.PLAYOFFS
    ) {
      const scheduled = await idb.cache.schedule.getAll();
      if (scheduled.length > 0) return "play_next_game";
    }
    return "advance_phase";
  };

  const legalActionCategories = async (): Promise<string[]> => {
    const categories = [
      "advance",
      "evaluate_trade",
      "get_state",
      "get_options",
      "checkpoint",
    ];
    const blocked = await isBlockedOnUserDraftPick();
    const pendingResignings = await hasPendingResigningNegotiations();
    if (!blocked) {
      categories.push(
        "execute_trade",
        "advertise_on_trading_block",
        "set_lineup",
        "release_player",
      );
      if (phaseNum() === ZENGM_PHASE.RESIGN_PLAYERS) {
        categories.push("negotiate_contract");
      } else if (phaseNum() === ZENGM_PHASE.FREE_AGENCY) {
        categories.push("sign_free_agent");
      }
    }
    if (pendingResignings) {
      return categories.filter(
        (category) =>
          category === "get_state" ||
          category === "get_options" ||
          category === "checkpoint" ||
          category === "negotiate_contract",
      );
    }
    if (blocked) categories.push("make_draft_pick");
    return categories;
  };

  // -- SimulationEngine methods ----------------------------------------------

  const create = async (input: CreateEpisodeInput): Promise<void> => {
    if (created)
      throw new Error(
        "Basketball GM adapter: an episode has already been created in this worker",
      );
    const confsHistory = zengm.defaultGameAttributes["confs"] ?? [];
    const divsHistory = zengm.defaultGameAttributes["divs"] ?? [];
    await core.league.createStream(zengm.createStreamFromLeagueObject({}), {
      confs: zengm.utils.last(confsHistory).value,
      divs: zengm.utils.last(divsHistory).value,
      fromFile: {
        gameAttributes: undefined,
        hasRookieContracts: true,
        maxGid: undefined,
        startingSeason: undefined,
        teams: undefined,
        version: constants.LEAGUE_DATABASE_VERSION,
      },
      getLeagueOptions: undefined,
      keptKeys: new Set(),
      lid: 0,
      name: `MCP ${input.episodeId}`,
      setLeagueCreationStatus: (status: unknown) => {
        if (process.env["BBGM_BRIDGE_VERBOSE"] === "1")
          console.error(
            `bbgm-bridge: league creation status: ${JSON.stringify(status)}`,
          );
      },
      settings: zengm.newLeague.getDefaultSettings(),
      shuffleRosters: false,
      startingSeasonFromInput: String(input.startingSeason),
      teamsFromInput: util.helpers.addPopRank(util.helpers.getTeamsDefault()),
      tid: input.userTeamId,
    });
    created = true;
  };

  const getRawState = async (): Promise<EngineRawState> => {
    requireCreated();
    const tid = userTid();
    const currentSeason = season();
    const cumulativeRecord = await cumulativeUserRecord(tid);

    // Basketball GM deliberately does not cache historical events when a
    // league is loaded (Cache.storeInfos.events has no getData hook). Reading
    // idb.cache.events after importSnapshot therefore returns only events
    // created since the restore, which makes an otherwise faithful rollback
    // appear to have changed state. Read the durable store directly so
    // recentTransactions remains stable across snapshot round trips.
    await idb.cache.flush();
    const league = idb.league;
    if (!league) throw new Error("No active league to read events from");
    const eventTransaction = league.transaction(["events"]);
    const eventRows = (await eventTransaction
      .objectStore("events")
      .getAll()) as RawEventRow[];
    await eventTransaction.done;

    const [
      rawTeams,
      rawRoster,
      freeAgentRows,
      undraftedRows,
      draftPickRows,
      scheduleRows,
      payroll,
    ] = await Promise.all([
      idb.cache.teams.getAll(),
      idb.cache.players.indexGetAll("playersByTid", tid),
      idb.cache.players.indexGetAll(
        "playersByTid",
        constants.PLAYER["FREE_AGENT"] ?? -1,
      ),
      idb.cache.players.indexGetAll(
        "playersByTid",
        constants.PLAYER["UNDRAFTED"] ?? -2,
      ),
      idb.cache.draftPicks.indexGetAll("draftPicksByTid", tid),
      idb.cache.schedule.getAll(),
      core.team.getPayroll(tid),
    ]);

    const teamSeasons = await Promise.all(
      rawTeams.map((team) =>
        idb.cache.teamSeasons.indexGet("teamSeasonsByTidSeason", [
          team.tid,
          currentSeason,
        ]),
      ),
    );
    const { confName, divName } = getConferenceDivisionNames();

    const standingsInput = rawTeams.map((team, index) => ({
      tid: team.tid,
      name: `${team.region} ${team.name}`,
      abbrev: team.abbrev,
      won: teamSeasons[index]?.won ?? 0,
      lost: teamSeasons[index]?.lost ?? 0,
      conference: confName.get(team.cid) ?? String(team.cid),
      division: divName.get(team.did) ?? String(team.did),
    }));
    const standings = computeStandings(standingsInput);

    const userTeamRow = rawTeams.find((team) => team.tid === tid);
    if (!userTeamRow)
      throw new Error(`Basketball GM adapter: user team ${tid} not found`);
    const userTeamSeason = teamSeasons[rawTeams.indexOf(userTeamRow)];
    const userStandingRank =
      standings.find((s) => s.tid === tid)?.rank ?? standings.length;

    const salaryCap = (g.get("salaryCap") as number) ?? 0;
    const luxuryTaxThreshold = (g.get("luxuryPayroll") as number) ?? 0;
    const hardCapActive = g.get("salaryCapType") === "hard";
    // Over the cap, zengm still permits minimum-salary signings
    // (contractNegotiation/accept.ts). Surface the bound so a policy can find
    // that legal move instead of deadlocking.
    const rosterMin =
      (g.get("minRosterSize") as number | undefined) ?? undefined;
    const rosterMax =
      (g.get("maxRosterSize") as number | undefined) ?? undefined;
    const minContract = (g.get("minContract") as number) ?? 0;
    const maxContract = (g.get("maxContract") as number) ?? 0;

    const transactions = eventRows
      .map((row) => mapTransactionRecord(row))
      .filter((tx): tx is NonNullable<typeof tx> => tx !== undefined)
      .sort((a, b) => b.transactionId - a.transactionId)
      .slice(0, 20);

    // g.get("day") THROWS (rather than returning undefined) when the "day"
    // game attribute has never been set -- confirmed against the real
    // engine: it stays unset until day-by-day simulation actually begins
    // (see src/worker/util/g.ts), so reading it right after create() throws
    // "Attempt to get g.day while it is not already set" for every episode
    // until its first advance(). Since EngineRawState.day is documented as
    // optional for exactly this reason, this is caught and treated as
    // "not yet available" rather than failing the whole getRawState() call
    // -- see compatibility.ts.
    let dayValue: number | undefined;
    try {
      dayValue = g.get("day") as number | undefined;
    } catch {
      dayValue = undefined;
    }
    const employment = employmentStatus();
    const rosterEnrichmentCache = await rosterEnrichment(tid);

    return {
      season: currentSeason,
      phase: phaseFromZengm(phaseNum()),
      ...(rosterMin === undefined ? {} : { rosterMin }),
      ...(rosterMax === undefined ? {} : { rosterMax }),
      ...(dayValue !== undefined ? { day: dayValue } : {}),
      ...(employment === undefined ? {} : { employmentStatus: employment }),
      userTeam: mapTeamSummary({
        team: userTeamRow,
        teamSeason: userTeamSeason,
        payroll,
        salaryCap,
        luxuryTaxThreshold,
        hardCapActive,
        minContract,
        maxContract,
        standingRank: userStandingRank,
        conferenceName:
          confName.get(userTeamRow.cid) ?? String(userTeamRow.cid),
        divisionName: divName.get(userTeamRow.did) ?? String(userTeamRow.did),
      }),
      ...(cumulativeRecord === undefined ? {} : { cumulativeRecord }),
      roster: applyEnrichment(
        normalizeRosterOrder(
          rawRoster.map((p) => mapPlayerToSummary(p, currentSeason)),
        ).sort((a, b) => b.overall - a.overall || a.pid - b.pid),
        rosterEnrichmentCache,
      ),
      freeAgents: freeAgentRows
        .map((p) => mapPlayerToSummary(p, currentSeason))
        .sort((a, b) => b.overall - a.overall || a.pid - b.pid),
      draftProspects: undraftedRows
        .map((p) => mapProspectToSummary(p, currentSeason))
        .sort((a, b) => b.scoutedOverall - a.scoutedOverall || a.pid - b.pid),
      draftPicks: (await idb.cache.draftPicks.getAll()).map((pick) =>
        mapDraftPickToSummary(pick, currentSeason),
      ),
      ownedPicks: draftPickRows.map((pick) =>
        mapDraftPickToSummary(pick, currentSeason),
      ),
      standings,
      schedule: scheduleRows.map((row) => mapScheduleGame(row, currentSeason)),
      recentTransactions: transactions,
      legalActionCategories: await legalActionCategories(),
      nextDecision: await nextDecisionLabel(),
    };
  };

  /** Per-player enrichment from zengm's own roster view, keyed by pid.
   * Raw IndexedDB rows carry none of this: mood/willingness, ratings deltas,
   * skill tags, engine valuation, tradability or production. Returns an empty
   * map when the view is unavailable so callers degrade to the raw mapping
   * rather than failing. */
  const rosterEnrichment = async (
    tid: number,
  ): Promise<Map<number, Partial<PlayerSummary>>> => {
    const out = new Map<number, Partial<PlayerSummary>>();
    const rosterView = zengm.views?.roster;
    if (!rosterView) return out;
    let view: unknown;
    try {
      view = await rosterView({
        tid,
        season: season(),
        playoffs: "regularSeason",
      });
    } catch {
      return out;
    }
    const players = (view as { players?: unknown[] } | undefined)?.players;
    if (!Array.isArray(players)) return out;
    for (const raw of players) {
      const p = raw as {
        pid?: number;
        untradable?: unknown;
        ratings?: { dovr?: number; dpot?: number; skills?: unknown };
        mood?: {
          user?: {
            willing?: boolean;
            probWilling?: number;
            contractAmount?: number;
          };
        };
        stats?: Record<string, number>;
      };
      if (typeof p.pid !== "number") continue;
      const mood = p.mood?.user;
      const stats = p.stats ?? {};
      const entry: Partial<PlayerSummary> = {};
      if (typeof p.ratings?.dovr === "number")
        entry.overallChange = p.ratings.dovr;
      if (typeof p.ratings?.dpot === "number")
        entry.potentialChange = p.ratings.dpot;
      if (Array.isArray(p.ratings?.skills))
        entry.skills = p.ratings.skills.filter(
          (skill): skill is string => typeof skill === "string",
        );
      if (typeof p.untradable === "boolean") entry.untradable = p.untradable;
      if (typeof mood?.willing === "boolean")
        entry.willingToNegotiate = mood.willing;
      if (typeof mood?.probWilling === "number")
        entry.probWilling = mood.probWilling;
      // zengm stores money in thousands; the wrapper reports millions.
      if (typeof mood?.contractAmount === "number")
        entry.askingAmount = mood.contractAmount / 1000;
      for (const [key, field] of [
        ["yearsWithTeam", "yearsWithTeam"],
        ["gp", "gamesPlayed"],
        ["min", "minutesPerGame"],
        ["pts", "pointsPerGame"],
        ["trb", "reboundsPerGame"],
        ["ast", "assistsPerGame"],
        ["per", "per"],
      ] as const) {
        const value = stats[key];
        if (typeof value === "number" && Number.isFinite(value))
          (entry as Record<string, number>)[field] = value;
      }
      out.set(p.pid, entry);
    }
    return out;
  };

  const applyEnrichment = (
    players: PlayerSummary[],
    enrichment: Map<number, Partial<PlayerSummary>>,
  ): PlayerSummary[] =>
    enrichment.size === 0
      ? players
      : players.map((player) => {
          const extra = enrichment.get(player.pid);
          return extra ? { ...player, ...extra } : player;
        });

  const getTeamRoster = async (params: {
    tid: number;
  }): Promise<PlayerSummary[]> => {
    requireCreated();
    const rows = await idb.cache.players.indexGetAll(
      "playersByTid",
      params.tid,
    );
    const enrichment = await rosterEnrichment(params.tid);
    return applyEnrichment(
      normalizeRosterOrder(
        rows.map((p) => mapPlayerToSummary(p, season())),
      ).sort((a, b) => b.overall - a.overall),
      enrichment,
    );
  };

  /** Deep single-player detail for bbgm_get_player, sourced from zengm's own
   * player worker view (src/worker/views/player.ts) rather than hand-mapped
   * IndexedDB rows -- that view already returns the full per-season ratings
   * and stats history (basic + advanced, computed by
   * worker/util/advStats.basketball.ts) plus contract schedule, awards,
   * draft info, and injury history in one call. See docs/INFORMATION_AUDIT.md.
   *
   * Deliberately excludes zengm's internal `value` field: that is the same
   * composite valuation the trade AI uses to judge offers, so surfacing it
   * would leak the counterparty's utility function to the policy.
   *
   * Maps defensively -- an unknown pid, a missing view, or an unexpected
   * shape all degrade to a mostly-empty PlayerDetail (just the requested
   * pid) rather than throwing, matching rosterEnrichment()'s convention
   * above. */
  const getPlayer = async (params: { pid: number }): Promise<PlayerDetail> => {
    requireCreated();
    const empty: PlayerDetail = {
      pid: params.pid,
      ratingsHistory: [],
      statsHistory: [],
      contractSchedule: [],
      awards: [],
      injuryHistory: [],
    };
    const playerView = zengm.views?.player;
    if (!playerView) return empty;
    let view: unknown;
    try {
      view = await playerView({ pid: params.pid });
    } catch {
      return empty;
    }
    const raw = view as
      | { player?: unknown; bestPos?: unknown; errorMessage?: unknown }
      | undefined;
    const p = raw?.player;
    if (typeof p !== "object" || p === null) return empty;
    const player = p as {
      pid?: unknown;
      name?: unknown;
      age?: unknown;
      tid?: unknown;
      contract?: { amount?: unknown; exp?: unknown };
      salaries?: unknown[];
      awards?: unknown[];
      injury?: { type?: unknown; gamesRemaining?: unknown };
      injuries?: unknown[];
      draft?: {
        year?: unknown;
        round?: unknown;
        pick?: unknown;
        originalTid?: unknown;
      };
      ratings?: unknown[];
      stats?: unknown[];
    };

    let latestPos: string | undefined;
    const ratingsHistory: PlayerRatingsSeason[] = Array.isArray(player.ratings)
      ? player.ratings
          .map((row): PlayerRatingsSeason | undefined => {
            if (typeof row !== "object" || row === null) return undefined;
            const r = row as Record<string, unknown>;
            if (typeof r["season"] !== "number") return undefined;
            if (typeof r["pos"] === "string") latestPos = r["pos"];
            const entry: PlayerRatingsSeason = { season: r["season"] };
            if (typeof r["tid"] === "number") entry.teamId = r["tid"];
            if (typeof r["age"] === "number") entry.age = r["age"];
            if (typeof r["ovr"] === "number") entry.overall = r["ovr"];
            if (typeof r["pot"] === "number") entry.potential = r["pot"];
            // zengm's own rating key is "stre"; the wrapper reports it as
            // "str" to match the standard 15-rating shorthand.
            for (const [key, field] of [
              ["hgt", "hgt"],
              ["stre", "str"],
              ["spd", "spd"],
              ["jmp", "jmp"],
              ["endu", "endu"],
              ["ins", "ins"],
              ["dnk", "dnk"],
              ["ft", "ft"],
              ["fg", "fg"],
              ["tp", "tp"],
              ["oiq", "oiq"],
              ["diq", "diq"],
              ["drb", "drb"],
              ["pss", "pss"],
              ["reb", "reb"],
            ] as const) {
              const value = r[key];
              if (typeof value === "number")
                (entry as unknown as Record<string, number>)[field] = value;
            }
            if (Array.isArray(r["skills"]))
              entry.skills = r["skills"].filter(
                (skill): skill is string => typeof skill === "string",
              );
            return entry;
          })
          .filter((entry): entry is PlayerRatingsSeason => entry !== undefined)
      : [];

    const statsHistory: PlayerStatsSeason[] = Array.isArray(player.stats)
      ? player.stats
          .map((row): PlayerStatsSeason | undefined => {
            if (typeof row !== "object" || row === null) return undefined;
            const s = row as Record<string, unknown>;
            if (typeof s["season"] !== "number") return undefined;
            const entry: PlayerStatsSeason = {
              season: s["season"],
              playoffs: s["playoffs"] === true,
            };
            if (typeof s["tid"] === "number") entry.teamId = s["tid"];
            for (const [key, field] of [
              ["gp", "gamesPlayed"],
              ["min", "minutesPerGame"],
              ["pts", "pointsPerGame"],
              ["trb", "reboundsPerGame"],
              ["ast", "assistsPerGame"],
              ["stl", "stealsPerGame"],
              ["blk", "blocksPerGame"],
              ["tov", "turnoversPerGame"],
              ["fgp", "fieldGoalPct"],
              ["tpp", "threePointPct"],
              ["ftp", "freeThrowPct"],
              ["per", "per"],
              ["ows", "offensiveWinShares"],
              ["dws", "defensiveWinShares"],
              ["ws", "winShares"],
              ["ws48", "winSharesPer48"],
              ["obpm", "offensiveBPM"],
              ["dbpm", "defensiveBPM"],
              ["bpm", "bpm"],
              ["vorp", "vorp"],
              ["tsp", "trueShootingPct"],
              ["usgp", "usagePct"],
            ] as const) {
              const value = s[key];
              if (typeof value === "number" && Number.isFinite(value))
                (entry as unknown as Record<string, number>)[field] = value;
            }
            return entry;
          })
          .filter((entry): entry is PlayerStatsSeason => entry !== undefined)
      : [];

    // zengm's playersPlus() already converts both `contract.amount` and each
    // `salaries[].amount` to millions of dollars for this attrs/season
    // combination (unlike rosterEnrichment's mood.contractAmount above,
    // which is raw thousands) -- see
    // worker/db/getCopies/playersPlus.ts's "contract"/"salaries" attr
    // handling. No further division here.
    const contractSchedule: PlayerContractYear[] = Array.isArray(
      player.salaries,
    )
      ? player.salaries
          .map((row): PlayerContractYear | undefined => {
            if (typeof row !== "object" || row === null) return undefined;
            const c = row as Record<string, unknown>;
            if (
              typeof c["season"] !== "number" ||
              typeof c["amount"] !== "number" ||
              (c["type"] !== "past" &&
                c["type"] !== "current" &&
                c["type"] !== "future")
            )
              return undefined;
            return {
              season: c["season"],
              amount: c["amount"],
              type: c["type"],
            };
          })
          .filter((entry): entry is PlayerContractYear => entry !== undefined)
      : [];

    const awards: PlayerAward[] = Array.isArray(player.awards)
      ? player.awards
          .map((row): PlayerAward | undefined => {
            if (typeof row !== "object" || row === null) return undefined;
            const a = row as Record<string, unknown>;
            if (
              typeof a["season"] !== "number" ||
              typeof a["type"] !== "string"
            )
              return undefined;
            return { season: a["season"], type: a["type"] };
          })
          .filter((entry): entry is PlayerAward => entry !== undefined)
      : [];

    const injuryHistory: PlayerInjuryHistoryEntry[] = Array.isArray(
      player.injuries,
    )
      ? player.injuries
          .map((row): PlayerInjuryHistoryEntry | undefined => {
            if (typeof row !== "object" || row === null) return undefined;
            const i = row as Record<string, unknown>;
            if (typeof i["type"] !== "string") return undefined;
            const entry: PlayerInjuryHistoryEntry = { type: i["type"] };
            if (typeof i["season"] === "number") entry.season = i["season"];
            if (typeof i["games"] === "number") entry.games = i["games"];
            return entry;
          })
          .filter(
            (entry): entry is PlayerInjuryHistoryEntry => entry !== undefined,
          )
      : [];

    let draft: PlayerDraftInfo | undefined;
    if (typeof player.draft === "object" && player.draft !== null) {
      const d = player.draft as Record<string, unknown>;
      const entry: PlayerDraftInfo = {};
      if (typeof d["year"] === "number") entry.year = d["year"];
      if (typeof d["round"] === "number") entry.round = d["round"];
      if (typeof d["pick"] === "number") entry.pick = d["pick"];
      if (typeof d["originalTid"] === "number")
        entry.originalTeamId = d["originalTid"];
      if (Object.keys(entry).length > 0) draft = entry;
    }

    let currentInjury: { type: string; gamesRemaining: number } | undefined;
    if (typeof player.injury === "object" && player.injury !== null) {
      const inj = player.injury as Record<string, unknown>;
      if (
        typeof inj["type"] === "string" &&
        typeof inj["gamesRemaining"] === "number"
      ) {
        currentInjury = {
          type: inj["type"],
          gamesRemaining: inj["gamesRemaining"],
        };
      }
    }

    const position = typeof raw?.bestPos === "string" ? raw.bestPos : latestPos;

    return {
      pid: params.pid,
      ...(typeof player.name === "string" ? { name: player.name } : {}),
      ...(typeof player.age === "number" ? { age: player.age } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(typeof player.tid === "number" ? { teamId: player.tid } : {}),
      ratingsHistory,
      statsHistory,
      ...(typeof player.contract?.amount === "number"
        ? { contractAmount: player.contract.amount }
        : {}),
      ...(typeof player.contract?.exp === "number"
        ? { contractExpires: player.contract.exp }
        : {}),
      contractSchedule,
      awards,
      ...(draft !== undefined ? { draft } : {}),
      ...(currentInjury !== undefined ? { currentInjury } : {}),
      injuryHistory,
    };
  };

  /** What the user has advertised on the trading block (if anything), the
   * offers judged against it, and the roster players / owned picks eligible
   * to advertise -- sourced from zengm's own trading-block worker view
   * (src/worker/views/tradingBlock.ts), called with no pids/dpids so it
   * reads back the currently saved advertisement instead of previewing a
   * candidate one. Never mutates. Degrades to an all-empty TradingBlockData
   * when the view is unavailable, throws, or returns an unexpected shape --
   * matching getPlayer()'s defensive-mapping convention above. */
  const getTradingBlock = async (): Promise<TradingBlockData> => {
    requireCreated();
    const empty: TradingBlockData = {
      advertisedPids: [],
      advertisedDpids: [],
      offers: [],
      tradableRoster: [],
      tradablePicks: [],
    };
    const tradingBlockView = zengm.views?.tradingBlock;
    if (!tradingBlockView) return empty;
    let view: unknown;
    try {
      view = await tradingBlockView({});
    } catch {
      return empty;
    }
    if (!isRecord(view)) return empty;

    const tradableRoster = mapAndSortTradableRoster(
      Array.isArray(view["userRoster"]) ? view["userRoster"] : [],
    );
    const tradablePicks = mapAndSortTradablePicks(
      Array.isArray(view["userPicks"]) ? view["userPicks"] : [],
    );

    const saved = isRecord(view["savedTradingBlock"])
      ? view["savedTradingBlock"]
      : undefined;
    const advertisedPids = Array.isArray(saved?.["pids"])
      ? saved["pids"].filter((pid): pid is number => typeof pid === "number")
      : [];
    const advertisedDpids = Array.isArray(saved?.["dpids"])
      ? saved["dpids"].filter(
          (dpid): dpid is number => typeof dpid === "number",
        )
      : [];
    const offers = mapAndSortOffers(
      Array.isArray(saved?.["offers"]) ? saved["offers"] : [],
    );

    return {
      advertisedPids,
      advertisedDpids,
      offers,
      tradableRoster,
      tradablePicks,
    };
  };

  /** AI-initiated trade offers the user did not solicit -- sourced from
   * zengm's own trade-proposals worker view (src/worker/views/
   * tradeProposals.ts). Never mutates. There is no separate "accept" path:
   * an offer here can be turned into a TradeProposal (offered=offer.offered,
   * requested=offer.requested, otherTeamId=offer.otherTeamId) and executed
   * via executeTrade -- see docs/INFORMATION_AUDIT.md and this adapter's
   * executeTrade(). Degrades to an empty offers list rather than throwing. */
  const getTradeProposals = async (): Promise<TradeProposalsData> => {
    requireCreated();
    const empty: TradeProposalsData = { offers: [] };
    const tradeProposalsView = zengm.views?.tradeProposals;
    if (!tradeProposalsView) return empty;
    let view: unknown;
    try {
      view = await tradeProposalsView({});
    } catch {
      return empty;
    }
    if (!isRecord(view)) return empty;
    const offers = mapAndSortOffers(
      Array.isArray(view["offers"]) ? view["offers"] : [],
    );
    return { offers };
  };

  const getOptions = async (): Promise<EngineOption[]> => {
    requireCreated();
    const options: EngineOption[] = [
      { type: "advance", target: "next_game" },
      { type: "advance", target: "next_decision" },
    ];
    const blocked = await isBlockedOnUserDraftPick();
    if (blocked) {
      const undraftedRows = await idb.cache.players.indexGetAll(
        "playersByTid",
        constants.PLAYER["UNDRAFTED"] ?? -2,
      );
      for (const p of undraftedRows)
        options.push({
          type: "make_draft_pick",
          pid: p.pid,
          name: `${p.firstName} ${p.lastName}`,
        });
    } else {
      const freeAgentRows = await idb.cache.players.indexGetAll(
        "playersByTid",
        constants.PLAYER["FREE_AGENT"] ?? -1,
      );
      const isResigning = phaseNum() === ZENGM_PHASE.RESIGN_PLAYERS;
      const candidateRows = isResigning
        ? (
            await idb.cache.players.indexGetAll("playersByTid", userTid())
          ).filter((player) => player.contract.exp <= season())
        : freeAgentRows;
      const type = isResigning ? "negotiate_contract" : "sign_free_agent";
      for (const p of candidateRows)
        options.push({
          type,
          pid: p.pid,
          name: `${p.firstName} ${p.lastName}`,
        });
      const roster = await idb.cache.players.indexGetAll(
        "playersByTid",
        userTid(),
      );
      for (const p of roster)
        options.push({
          type: "release_player",
          pid: p.pid,
          name: `${p.firstName} ${p.lastName}`,
        });
    }
    return options;
  };

  const toZengmTradeTeams = (proposal: TradeProposal): ZengmTradeTeams => {
    const pidsOf = (assets: TradeAsset[]): number[] =>
      assets
        .filter(
          (a): a is Extract<TradeAsset, { type: "player" }> =>
            a.type === "player",
        )
        .map((a) => a.pid);
    const dpidsOf = (assets: TradeAsset[]): number[] =>
      assets
        .filter(
          (a): a is Extract<TradeAsset, { type: "draft_pick" }> =>
            a.type === "draft_pick",
        )
        .map((a) => a.dpid);
    return [
      {
        tid: userTid(),
        pids: pidsOf(proposal.offered),
        dpids: dpidsOf(proposal.offered),
      },
      {
        tid: proposal.otherTeamId,
        pids: pidsOf(proposal.requested),
        dpids: dpidsOf(proposal.requested),
      },
    ];
  };

  const evaluateTrade = async (
    proposal: TradeProposal,
  ): Promise<TradeEvaluation> => {
    requireCreated();
    const teams = toZengmTradeTeams(proposal);
    const summary = await core.trade.summary(teams);
    const legal = summary.warning === null;

    let acceptedByOtherTeam: boolean | null = null;
    if (legal) {
      const dv = await new core.team.ValueChangeCalculator().evaluate({
        tid: teams[1].tid,
        pidsAdd: teams[0].pids,
        pidsRemove: teams[1].pids,
        dpidsAdd: teams[0].dpids,
        dpidsRemove: teams[1].dpids,
        tradingPartnerTid: teams[0].tid,
      });
      acceptedByOtherTeam = dv > 0;
    }

    const payrollDelta =
      summary.teams[0].payrollAfterTrade - summary.teams[0].payrollBeforeTrade;
    const rosterSizeDelta = teams[1].pids.length - teams[0].pids.length;

    const reasons: string[] = [];
    if (summary.warning) reasons.push(summary.warning);
    if (legal && acceptedByOtherTeam === false)
      reasons.push("The other team's front office would not accept this offer");
    if (reasons.length === 0) reasons.push("Trade is legal and balanced");

    return {
      legal,
      acceptedByOtherTeam,
      reasons,
      payrollDelta,
      rosterSizeDelta,
      assetsExchanged: {
        offered: proposal.offered,
        requested: proposal.requested,
      },
    };
  };

  const executeTrade = async (
    proposal: TradeProposal,
  ): Promise<EngineEvent[]> => {
    requireCreated();
    const teams = toZengmTradeTeams(proposal);
    await api.main.createTrade(teams);
    const result = await api.main.proposeTrade(false, conditions);
    if (!result.accepted) {
      throw new Error(
        `Trade was not executable: ${result.message ?? "rejected by the other team"}`,
      );
    }
    await idb.cache.flush();
    return [{ type: "trade", otherTeamId: proposal.otherTeamId }];
  };

  /** Advertises the given roster players / owned picks on the trading
   * block -- calls zengm's own api.main.getTradingBlockOffers, the same
   * function the real UI's "Ask For Trade Proposals" button calls, which
   * both computes AI counter-offers AND persists the advertisement
   * (idb.cache.savedTradingBlock) as a side effect. Does not reimplement any
   * trade-offer logic. An empty pids/dpids pair clears the trading block. */
  const advertiseOnTradingBlock = async (
    input: AdvertiseOnTradingBlockInput,
  ): Promise<EngineEvent[]> => {
    requireCreated();
    const offers = await api.main.getTradingBlockOffers({
      pids: input.pids,
      dpids: input.dpids,
      lookingFor: NEUTRAL_LOOKING_FOR,
    });
    await idb.cache.flush();
    return [
      {
        type: "trading_block_advertised",
        pids: input.pids,
        dpids: input.dpids,
        offerCount: Array.isArray(offers) ? offers.length : 0,
      },
    ];
  };

  const setLineup = async (input: SetLineupInput): Promise<EngineEvent[]> => {
    requireCreated();
    await api.main.reorderRosterDrag(input.order);
    await idb.cache.flush();
    return [{ type: "lineup_set", order: input.order }];
  };

  const releasePlayer = async (
    input: ReleasePlayerInput,
  ): Promise<EngineEvent[]> => {
    requireCreated();
    const error = await api.main.releasePlayer({ pids: [input.pid] });
    if (error)
      throw new Error(`Could not release player ${input.pid}: ${error}`);
    // BBGM can leave a resigning negotiation row behind when a player is
    // released before the resigning phase. Remove that orphaned row so a
    // later advance is not permanently blocked on a player who is no longer
    // on the user's roster.
    await idb.cache.negotiations.delete(input.pid);
    await idb.cache.flush();
    return [{ type: "release", pid: input.pid }];
  };

  const negotiateContract = async (
    input: NegotiateContractInput,
  ): Promise<EngineEvent[]> => {
    requireCreated();
    const negotiationOrError = await core.contractNegotiation.create(
      input.pid,
      true,
      userTid(),
    );
    if (typeof negotiationOrError !== "string") {
      // The real UI persists the negotiation before opening the negotiation
      // page. Resigning leagues can already contain these rows when the
      // headless episode starts, so only add the row when it is not present;
      // blindly adding it causes a duplicate-key failure on a valid retry.
      const existingNegotiation = await idb.cache.negotiations.get(input.pid);
      if (!existingNegotiation) {
        await idb.cache.negotiations.add(negotiationOrError);
      }
      const acceptError = await api.main.acceptContractNegotiation({
        pid: input.pid,
        amount: input.amount * 1000,
        exp: season() + input.years,
      });
      if (typeof acceptError === "string") {
        throw new Error(`Could not extend player ${input.pid}: ${acceptError}`);
      }
    } else {
      // See compatibility.ts ("negotiateContract"): zengm has no real
      // negotiation path for a currently-rostered player who is not a free
      // agent, so we fall back to writing the contract directly.
      const p = await idb.cache.players.get(input.pid);
      if (!p) throw new Error(`Player ${input.pid} not found`);
      if (p.tid !== userTid())
        throw new Error(`Player ${input.pid} is not on the user's roster`);
      core.player.setContract(
        p,
        { amount: input.amount * 1000, exp: season() + input.years },
        true,
      );
      await idb.cache.players.put(p);
    }
    await idb.cache.flush();
    return [
      {
        type: "contract_extension",
        pid: input.pid,
        amount: input.amount,
        years: input.years,
      },
    ];
  };

  const signFreeAgent = async (
    input: SignFreeAgentInput,
  ): Promise<EngineEvent[]> => {
    requireCreated();
    const negotiationOrError = await core.contractNegotiation.create(
      input.pid,
      false,
      userTid(),
    );
    if (typeof negotiationOrError === "string") {
      throw new EngineActionRejectedError(
        `Could not sign free agent ${input.pid}: ${negotiationOrError}`,
        {
          pid: input.pid,
          reason: "upstream_negotiation_preflight_rejected",
        },
      );
    }
    const acceptError = await api.main.acceptContractNegotiation({
      pid: input.pid,
      amount: input.amount * 1000,
      exp: season() + input.years,
    });
    if (typeof acceptError === "string")
      throw new Error(`Could not sign free agent ${input.pid}: ${acceptError}`);
    await idb.cache.flush();
    return [
      {
        type: "sign",
        pid: input.pid,
        amount: input.amount,
        years: input.years,
      },
    ];
  };

  const makeDraftPick = async (
    input: MakeDraftPickInput,
  ): Promise<EngineEvent[]> => {
    requireCreated();
    if (!(await isBlockedOnUserDraftPick())) {
      throw new Error(
        "It is not currently the user's turn to make a draft pick",
      );
    }
    await api.main.draftUser(input.pid, conditions);
    await idb.cache.flush();
    return [{ type: "draft", pid: input.pid }];
  };

  const advance = async (input: AdvanceInput): Promise<EngineEvent[]> => {
    requireCreated();
    const events: EngineEvent[] = [];
    const stop = (reason: string): EngineEvent[] => {
      events.push({ type: "advance_complete", reason });
      return events;
    };

    if (await isBlockedOnUserDecision())
      return stop("blocked_pending_decision");

    const phaseBefore = phaseNum();
    const seasonBefore = season();
    const dayBefore = currentDay();

    const playMenuAction = PLAY_MENU_TARGET_ACTION[input.target];
    if (playMenuAction !== undefined) {
      // The headless worker cannot answer upstream's resigning confirmation
      // dialog. Treat this explicit target the same way the phase-step path
      // treats it: a deliberate user request to proceed to free agency.
      if (
        playMenuAction === "untilFreeAgency" &&
        phaseNum() === ZENGM_PHASE.RESIGN_PLAYERS
      ) {
        await core.phase.newPhase(ZENGM_PHASE.FREE_AGENCY, conditions);
        await waitForUpstreamSimulation();
      } else {
        const fn = api.playMenu[playMenuAction];
        if (!fn) {
          throw new Error(
            `Basketball GM adapter: api.playMenu.${playMenuAction} was not found on the imported zengm module`,
          );
        }
        try {
          await fn(undefined, conditions);
          await waitForUpstreamSimulation();
        } catch (error) {
          // Some real leagues do not materialize the synthetic All-Star or
          // trade-deadline marker in the schedule returned by the upstream
          // helper. In that case the helper throws before starting any
          // simulation. Use the awaited day-step controller, which reaches
          // the same milestone without relying on that optional marker and
          // keeps the failed helper call out of the mutation/rollback path.
          if (
            input.target === "until_all_star_game" ||
            input.target === "until_trade_deadline"
          ) {
            return advanceByPhaseStepsUntilMilestone(
              input.target,
              seasonBefore,
            );
          }
          throw error;
        }
      }
      const reached = await assertMilestoneReached(
        input.target,
        seasonBefore,
        phaseBefore,
        dayBefore,
      );
      if (reached) return stop(`completed_${input.target}`);
      // Some pinned BBGM play-menu helpers legitimately return after
      // scheduling zero days (for example a freshly-created regular-season
      // schedule can lack a special marker until the first day step). Fall
      // back to the same bounded phase-step controller used by next_decision
      // instead of declaring success or surfacing a spurious no-op failure.
      return advanceByPhaseStepsUntilMilestone(input.target, seasonBefore);
    }

    switch (input.target) {
      case "next_game": {
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (await isBlockedOnUserDecision())
            return stop("blocked_pending_decision");
          const before = await getUserGamesPlayed();
          await stepOneZengmPhase();
          const after = await getUserGamesPlayed();
          if (after > before) {
            events.push({ type: "game", gamesPlayed: after });
            return stop("played_one_game");
          }
          if (phaseNum() !== phaseBefore) return stop("reached_next_phase");
        }
        return stop("hit_step_limit");
      }
      case "days": {
        const count = input.count ?? 1;
        for (let i = 0; i < count; i += 1) {
          if (await isBlockedOnUserDecision())
            return stop("blocked_pending_decision");
          await api.playMenu["day"]?.(undefined, conditions);
        }
        return stop("completed_requested_days");
      }
      case "games": {
        const count = input.count ?? 1;
        let played = 0;
        for (
          let step = 0;
          step < MAX_ADVANCE_STEPS && played < count;
          step += 1
        ) {
          if (await isBlockedOnUserDecision())
            return stop("blocked_pending_decision");
          const before = await getUserGamesPlayed();
          await stepOneZengmPhase();
          const after = await getUserGamesPlayed();
          if (after > before) {
            played += 1;
            events.push({ type: "game", gamesPlayed: after });
          }
        }
        return stop(
          played >= count ? "completed_requested_games" : "hit_step_limit",
        );
      }
      case "next_decision":
      case "phase": {
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (await isBlockedOnUserDecision())
            return stop("blocked_pending_decision");
          await stepOneZengmPhase();
          if (phaseNum() !== phaseBefore) return stop("reached_next_phase");
        }
        return stop("hit_step_limit");
      }
      case "season_end": {
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (await isBlockedOnUserDecision())
            return stop("blocked_pending_decision");
          await stepOneZengmPhase();
          if (season() !== seasonBefore) return stop("season_complete");
        }
        return stop("hit_step_limit");
      }
      default:
        throw new Error(
          `Unknown advance target: ${String((input as { target: unknown }).target)}`,
        );
    }
  };

  const exportSnapshot = async (): Promise<unknown> => {
    requireCreated();
    if (!db.idb.league) throw new Error("No active league to snapshot");
    await idb.cache.flush();
    const stores = Array.from(db.idb.league.objectStoreNames);
    const transaction = db.idb.league.transaction(stores);
    const data: Record<string, unknown[]> = {};
    await Promise.all(
      stores.map(async (storeName) => {
        data[storeName] = await transaction.objectStore(storeName).getAll();
      }),
    );
    await transaction.done;
    return { lid: g.get("lid"), data };
  };

  const importSnapshot = async (snapshot: unknown): Promise<void> => {
    const typed = parseLeagueSnapshot(snapshot);
    await core.league.close(true);
    const connection = await db.connectLeague(typed.lid);
    const storeNames = Object.keys(typed.data);
    const transaction = connection.transaction(storeNames, "readwrite");
    for (const storeName of storeNames) {
      const store = transaction.objectStore(storeName);
      await store.clear();
      for (const row of typed.data[storeName] ?? []) await store.put(row);
    }
    await transaction.done;
    connection.close();

    // IndexedDB is installed per worker, so a fresh worker has no
    // meta.leagues entry for the restored league. The league database can be
    // reconstructed from the snapshot, but beforeLeague() checks the
    // separate meta database first and otherwise throws the upstream
    // "League not found." error. Recreate only the metadata that the normal
    // league-loading path needs; simulation state remains in the snapshot.
    await idb.meta.put("leagues", leagueMetadataFromSnapshot(typed));
    await zengm.beforeView.beforeLeague(typed.lid, {});
    const restoredLeague = db.idb.league;
    if (!restoredLeague) throw new Error("Restored league did not reconnect");
    const verificationTransaction = restoredLeague.transaction(["events"]);
    const restoredEventCount = (
      await verificationTransaction.objectStore("events").getAll()
    ).length;
    await verificationTransaction.done;
    const expectedEventCount = typed.data["events"]?.length ?? 0;
    if (restoredEventCount !== expectedEventCount) {
      throw new Error(
        `Restored league event count mismatch: expected ${expectedEventCount}, got ${restoredEventCount}`,
      );
    }
    created = true;
  };

  const close = async (): Promise<void> => {
    if (created) {
      const lid = g.get("lid") as number | undefined;
      if (lid !== undefined) await core.league.remove(lid);
    }
    await db.idb.meta.close();
    created = false;
  };

  return {
    create,
    getRawState,
    getTeamRoster,
    getPlayer,
    getOptions,
    evaluateTrade,
    getTradingBlock,
    getTradeProposals,
    executeTrade,
    advertiseOnTradingBlock,
    setLineup,
    releasePlayer,
    negotiateContract,
    signFreeAgent,
    makeDraftPick,
    advance,
    exportSnapshot,
    importSnapshot,
    close,
  };
}
