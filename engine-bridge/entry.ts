import "fake-indexeddb/auto";

import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Request = { id: number; method: string; params?: unknown };

if (!parentPort) throw new Error("Basketball GM bridge must run in a worker thread");

Object.assign(globalThis, {
  self: globalThis,
  window: globalThis,
  location: {},
  addEventListener: () => {},
  postMessage: () => {},
});
process.env["SPORT"] = "basketball";
process.env["NODE_ENV"] = "production";

globalThis.fetch = async (input: string | URL | RequestInfo) => {
  if (typeof input !== "string") throw new Error("Headless bridge only supports string fetch paths");
  let filePath = input.replace("/gen/", "data/");
  if (filePath.endsWith("real-player-data.json")) {
    filePath = filePath.replace(".json", ".basketball.json");
  }
  const sourceDir = (workerData as { sourceDir: string }).sourceDir;
  return new Response(await readFile(resolve(sourceDir, filePath)));
};

const [{ PHASE, LEAGUE_DATABASE_VERSION }, { defaultGameAttributes }, { last }, core, database, util, { getDefaultSettings }, { default: createStreamFromLeagueObject }, { beforeLeague }] =
  await Promise.all([
    import("../src/common/constants.ts"),
    import("../src/common/defaultGameAttributes.ts"),
    import("../src/common/utils.ts"),
    import("../src/worker/core/index.ts"),
    import("../src/worker/db/index.ts"),
    import("../src/worker/util/index.ts"),
    import("../src/worker/views/newLeague.ts"),
    import("../src/worker/core/league/create/createStreamFromLeagueObject.ts"),
    import("../src/worker/util/beforeView.ts"),
  ]);

await import("../src/worker/index.ts");

const { league, team } = core;
const { connectLeague, idb } = database;
const { g, helpers } = util;

let rngState = 1;
let created = false;

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
};

Math.random = () => {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0x1_0000_0000;
};

const phaseName = (phase: number): string =>
  Object.entries(PHASE).find(([, value]) => value === phase)?.[0]?.toLowerCase() ?? `phase_${phase}`;

const create = async (params: {
  episodeId: string;
  scenarioId: string;
  seed: string;
  userTeamId: number;
  startingSeason: number;
}) => {
  if (created) throw new Error("Bridge already contains an episode");
  rngState = hashSeed(params.seed);
  console.error("bbgm-bridge: creating league");
  await league.createStream(createStreamFromLeagueObject({}), {
    confs: last(defaultGameAttributes.confs).value,
    divs: last(defaultGameAttributes.divs).value,
    fromFile: {
      gameAttributes: undefined,
      hasRookieContracts: true,
      maxGid: undefined,
      startingSeason: undefined,
      teams: undefined,
      version: LEAGUE_DATABASE_VERSION,
    },
    getLeagueOptions: undefined,
    keptKeys: new Set(),
    lid: 0,
    name: `MCP ${params.episodeId}`,
    setLeagueCreationStatus: () => {},
    settings: getDefaultSettings(),
    shuffleRosters: false,
    startingSeasonFromInput: String(params.startingSeason),
    teamsFromInput: helpers.addPopRank(helpers.getTeamsDefault()),
    tid: params.userTeamId,
  });
  created = true;
  console.error("bbgm-bridge: league created");
};

const getState = async (params: { episodeId: string; scenarioId: string; seed: string }) => {
  if (!created) throw new Error("Bridge episode has not been created");
  const season = g.get("season");
  const tid = g.get("userTid");
  const [rawTeam, teamSeason, rawPlayers, payroll] = await Promise.all([
    idb.cache.teams.get(tid),
    idb.cache.teamSeasons.indexGet("teamSeasonsByTidSeason", [tid, season]),
    idb.cache.players.indexGetAll("playersByTid", tid),
    team.getPayroll(tid),
  ]);
  if (!rawTeam) throw new Error(`User team ${tid} not found`);
  const salaryCap = g.get("salaryCap");
  const minRosterSize = g.get("minRosterSize");
  const maxRosterSize = g.get("maxRosterSize");
  const roster = rawPlayers
    .map((player) => {
      const ratings = player.ratings.at(-1);
      if (!ratings) throw new Error(`Player ${player.pid} has no ratings`);
      return {
        pid: player.pid,
        name: `${player.firstName} ${player.lastName}`,
        age: season - player.born.year,
        position: ratings.pos,
        overall: ratings.ovr,
        potential: ratings.pot,
        contractAmount: player.contract.amount / 1000,
        contractExpires: player.contract.exp,
        injuryGamesRemaining: player.injury.gamesRemaining,
      };
    })
    .sort((a, b) => b.overall - a.overall || a.pid - b.pid);
  return {
    schemaVersion: "1" as const,
    episodeId: params.episodeId,
    scenarioId: params.scenarioId,
    seed: params.seed,
    engine: {
      name: "basketball-gm",
      version: "5.1.0",
      commit: "4ee432c5b9097ed978749a049fff5823711690dc",
    },
    season,
    phase: phaseName(g.get("phase")),
    userTeam: {
      tid,
      name: `${rawTeam.region} ${rawTeam.name}`,
      won: teamSeason?.won ?? 0,
      lost: teamSeason?.lost ?? 0,
      payroll: payroll / 1000,
      salaryCap: salaryCap / 1000,
      capSpace: (salaryCap - payroll) / 1000,
    },
    roster,
    constraints: [
      {
        code: "ROSTER_MINIMUM",
        satisfied: roster.length >= minRosterSize,
        message: `${roster.length} players; minimum is ${minRosterSize}`,
      },
      {
        code: "ROSTER_MAXIMUM",
        satisfied: roster.length <= maxRosterSize,
        message: `${roster.length} players; maximum is ${maxRosterSize}`,
      },
    ],
    legalActionCategories: ["advance", "evaluate_trade"],
    nextDecision: g.get("phase") <= PHASE.PLAYOFFS ? "next_game" : phaseName(g.get("phase")),
  };
};

const exportSnapshot = async () => {
  if (!created || !idb.league) throw new Error("No active league to snapshot");
  await idb.cache.flush();
  const stores = Array.from(idb.league.objectStoreNames);
  const transaction = idb.league.transaction(stores);
  const data: Record<string, unknown[]> = {};
  await Promise.all(
    stores.map(async (storeName) => {
      data[storeName] = await transaction.objectStore(storeName).getAll();
    }),
  );
  await transaction.done;
  return { lid: g.get("lid"), rngState, data };
};

const importSnapshot = async (snapshot: {
  lid: number;
  rngState: number;
  data: Record<string, unknown[]>;
}) => {
  const lid = snapshot.lid;
  await league.close(true);
  const connection = await connectLeague(lid);
  const storeNames = Object.keys(snapshot.data);
  const transaction = connection.transaction(storeNames, "readwrite");
  for (const storeName of storeNames) {
    const store = transaction.objectStore(storeName);
    await store.clear();
    for (const row of snapshot.data[storeName] ?? []) await store.put(row);
  }
  await transaction.done;
  connection.close();
  rngState = snapshot.rngState;
  await beforeLeague(lid, {});
};

const handlers: Record<string, (params: any) => Promise<unknown>> = {
  create,
  getState,
  getOptions: async () => [
    { type: "advance", target: "next_game" },
    { type: "advance", target: "games", maxCount: 30 },
  ],
  evaluateTrade: async () => ({
    legal: false,
    acceptedByOtherTeam: null,
    reasons: ["Real trade evaluation bridge is not implemented yet"],
    payrollDelta: 0,
    rosterSizeDelta: 0,
  }),
  executeTrade: async () => {
    throw new Error("Real trade execution bridge is not implemented yet");
  },
  advance: async (params: { target: string; count?: number }) => {
    const count = params.target === "games" ? (params.count ?? 1) : 1;
    const before = await idb.cache.teamSeasons.indexGet("teamSeasonsByTidSeason", [
      g.get("userTid"),
      g.get("season"),
    ]);
    for (let index = 0; index < count; index += 1) {
      await self.bbgm.api.playMenu.day(undefined, {});
    }
    const after = await idb.cache.teamSeasons.indexGet("teamSeasonsByTidSeason", [
      g.get("userTid"),
      g.get("season"),
    ]);
    return [
      {
        type: "advance",
        requested: count,
        gamesBefore: (before?.won ?? 0) + (before?.lost ?? 0),
        gamesAfter: (after?.won ?? 0) + (after?.lost ?? 0),
      },
    ];
  },
  exportSnapshot,
  importSnapshot,
  close: async () => {
    if (created && g.get("lid") !== undefined) await league.remove(g.get("lid"));
    await idb.meta.close();
    created = false;
  },
};

parentPort.on("message", (request: Request) => {
  void (async () => {
    try {
      console.error(`bbgm-bridge: ${request.method} start`);
      const handler = handlers[request.method];
      if (!handler) throw new Error(`Unknown bridge method: ${request.method}`);
      parentPort.postMessage({ id: request.id, result: await handler(request.params) });
      console.error(`bbgm-bridge: ${request.method} complete`);
    } catch (error) {
      parentPort.postMessage({
        id: request.id,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
      });
    }
  })();
});
