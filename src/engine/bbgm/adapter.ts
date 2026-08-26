import type {
  AdvanceInput,
  CreateEpisodeInput,
  EngineEvent,
  EngineOption,
  EngineRawState,
  MakeDraftPickInput,
  NegotiateContractInput,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeAsset,
  TradeEvaluation,
  TradeProposal,
} from "../../domain/types.js";

import {
  computeStandings,
  mapDraftPickToSummary,
  mapPlayerToSummary,
  mapProspectToSummary,
  mapScheduleGame,
  mapTeamSummary,
  mapTransactionRecord,
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

export type ZengmModules = {
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
        trade: StoreApi<{ rid: number; teams: ZengmTradeTeams }>;
        flush: () => Promise<void>;
      };
      league:
        | {
            objectStoreNames: Iterable<string>;
            transaction: (storeNames: string[]) => IdbTransactionLike;
          }
        | undefined;
      meta: { close: () => Promise<void> };
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
      }) => Promise<string | undefined>;
      createTrade: (teams: ZengmTradeTeams) => Promise<void>;
      proposeTrade: (
        forceTrade: boolean,
        conditions: ZengmConditions,
      ) => Promise<{ accepted: boolean; message: string | null }>;
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

export type BasketballGmAdapter = {
  create(input: CreateEpisodeInput): Promise<void>;
  getRawState(): Promise<EngineRawState>;
  getOptions(): Promise<EngineOption[]>;
  evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation>;
  executeTrade(proposal: TradeProposal): Promise<EngineEvent[]>;
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
    if (!blocked) {
      categories.push(
        "execute_trade",
        "set_lineup",
        "release_player",
        "negotiate_contract",
        "sign_free_agent",
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

    const [
      rawTeams,
      rawRoster,
      freeAgentRows,
      undraftedRows,
      draftPickRows,
      scheduleRows,
      eventRows,
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
      idb.cache.events.getAll(),
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

    return {
      season: currentSeason,
      phase: phaseFromZengm(phaseNum()),
      ...(dayValue !== undefined ? { day: dayValue } : {}),
      userTeam: mapTeamSummary({
        team: userTeamRow,
        teamSeason: userTeamSeason,
        payroll,
        salaryCap,
        luxuryTaxThreshold,
        hardCapActive,
        standingRank: userStandingRank,
        conferenceName:
          confName.get(userTeamRow.cid) ?? String(userTeamRow.cid),
        divisionName: divName.get(userTeamRow.did) ?? String(userTeamRow.did),
      }),
      roster: rawRoster
        .map((p) => mapPlayerToSummary(p, currentSeason))
        .sort((a, b) => b.overall - a.overall),
      freeAgents: freeAgentRows
        .map((p) => mapPlayerToSummary(p, currentSeason))
        .sort((a, b) => b.overall - a.overall),
      draftProspects: undraftedRows
        .map((p) => mapProspectToSummary(p, currentSeason))
        .sort((a, b) => b.scoutedOverall - a.scoutedOverall),
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
      for (const p of freeAgentRows)
        options.push({
          type: "sign_free_agent",
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
      const acceptError = await api.main.acceptContractNegotiation({
        pid: input.pid,
        amount: input.amount * 1000,
        exp: season() + input.years,
      });
      if (acceptError)
        throw new Error(`Could not extend player ${input.pid}: ${acceptError}`);
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
      throw new Error(
        `Could not sign free agent ${input.pid}: ${negotiationOrError}`,
      );
    }
    const acceptError = await api.main.acceptContractNegotiation({
      pid: input.pid,
      amount: input.amount * 1000,
      exp: season() + input.years,
    });
    if (acceptError)
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

    if (await isBlockedOnUserDraftPick())
      return stop("blocked_pending_decision");

    const phaseBefore = phaseNum();
    const seasonBefore = season();

    switch (input.target) {
      case "next_game": {
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (await isBlockedOnUserDraftPick())
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
          if (await isBlockedOnUserDraftPick())
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
          if (await isBlockedOnUserDraftPick())
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
          if (await isBlockedOnUserDraftPick())
            return stop("blocked_pending_decision");
          await stepOneZengmPhase();
          if (phaseNum() !== phaseBefore) return stop("reached_next_phase");
        }
        return stop("hit_step_limit");
      }
      case "season_end": {
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (await isBlockedOnUserDraftPick())
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
    const typed = snapshot as { lid: number; data: Record<string, unknown[]> };
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
    await zengm.beforeView.beforeLeague(typed.lid, {});
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
    getOptions,
    evaluateTrade,
    executeTrade,
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
