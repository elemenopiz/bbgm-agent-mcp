// Worker-thread entry point for the real Basketball GM engine. Bundled by
// scripts/build-engine-bridge.ts (via zengm's own rolldown + sportFunctions
// plugin) after being copied, alongside adapter.ts/mappings.ts/
// compatibility.ts, into the pinned zengm checkout's `.mcp-bridge/`
// directory -- that copy step is what makes the `../src/worker/...` import
// paths below resolve correctly regardless of where BBGM_SOURCE_DIR points.
// See docs/ENGINE_INTEGRATION.md for the full rationale.
//
// This file is intentionally thin: bootstrap.ts installs the worker globals,
// adapter.ts contains every actual zengm call, and this file only wires the
// two together and runs a serialized request/response dispatch loop over
// `parentPort`. It is NOT part of this repo's `tsc --noEmit` include set
// (see tsconfig.json) -- it is transpiled (types stripped, not
// type-checked) by rolldown, the same way the rest of the zengm build
// pipeline handles its own `.ts` sources.

import { parentPort, workerData } from "node:worker_threads";

// These two are authored at their real repo location (per this project's
// file-ownership map, bootstrap.ts/adapter.ts live under src/engine/bbgm/,
// not next to this file) with standard NodeNext ".js" specifiers, so tsc
// resolves and type-checks them normally from within this repo -- the same
// way every other file in this project imports its siblings.
// scripts/build-engine-bridge.ts rewrites these two specifiers to
// flat-sibling ".ts" form ("./bootstrap.ts"/"./adapter.ts") when it copies
// this file -- together with bootstrap.ts, adapter.ts, and mappings.ts,
// copied unchanged as flat siblings -- into the pinned zengm checkout's
// `.mcp-bridge/` directory for bundling by zengm's own rolldown, which
// resolves raw ".ts" specifiers directly (matching the zengm imports
// below). See that script and docs/ENGINE_INTEGRATION.md for the full
// rationale.
import {
  installSeededRandom,
  installWorkerGlobals,
} from "../src/engine/bbgm/bootstrap.js";
import { createBasketballGmAdapter } from "../src/engine/bbgm/adapter.js";

type Request = { id: number; method: string; params?: unknown };
type ResponseError = { message: string; stack?: string };
type Response = { id: number; result?: unknown; error?: ResponseError };

if (!parentPort)
  throw new Error("Basketball GM bridge must run in a worker thread");
const port = parentPort;

const { sourceDir } = workerData as { sourceDir: string };
await installWorkerGlobals(sourceDir);

// Every zengm module the adapter needs. Imported here (after
// installWorkerGlobals, before anything touches indexedDB/self/window) and
// handed to createBasketballGmAdapter as plain data -- see adapter.ts's
// ZengmModules doc comment for why the dependency direction runs this way.
const [
  { PHASE, PLAYER, LEAGUE_DATABASE_VERSION },
  { defaultGameAttributes },
  { last },
  core,
  database,
  util,
  { getDefaultSettings },
  { default: createStreamFromLeagueObject },
  { beforeLeague },
  { ValueChangeCalculator },
] = await Promise.all([
  import("../src/common/constants.ts"),
  import("../src/common/defaultGameAttributes.ts"),
  import("../src/common/utils.ts"),
  import("../src/worker/core/index.ts"),
  import("../src/worker/db/index.ts"),
  import("../src/worker/util/index.ts"),
  import("../src/worker/views/newLeague.ts"),
  import("../src/worker/core/league/create/createStreamFromLeagueObject.ts"),
  import("../src/worker/util/beforeView.ts"),
  import("../src/worker/core/team/ValueChangeCalculator.ts"),
]);

// worker/index.ts assigns `self.bbgm = { ...common, ...core, ...db, ...util, api, ... }`
// as a side effect. bootstrap.ts already pointed `self` at `globalThis`, so
// `globalThis.bbgm.api` is how we reach the high-level api/* functions
// (api.playMenu.*, and api.main.{releasePlayer, reorderRosterDrag,
// draftUser, acceptContractNegotiation, createTrade, proposeTrade}) that
// adapter.ts calls -- the same functions zengm's own UI calls, rather than
// reimplementing their logic. See adapter.ts's ZengmModules.api doc comment
// for why most of these are nested under `.main` rather than top-level.
await import("../src/worker/index.ts");
const bbgm = (
  globalThis as unknown as { bbgm: { api: Record<string, unknown> } }
).bbgm;

const adapter = createBasketballGmAdapter({
  core: {
    player: { setContract: core.player.setContract },
    contractNegotiation: { create: core.contractNegotiation.create },
    trade: { summary: core.trade.summary },
    team: { getPayroll: core.team.getPayroll, ValueChangeCalculator },
    draft: { getOrder: core.draft.getOrder },
    league: {
      createStream: core.league.createStream,
      close: core.league.close,
      remove: core.league.remove,
    },
    phase: { newPhase: core.phase.newPhase },
  },
  db: {
    idb: database.idb,
    connectLeague: database.connectLeague,
  },
  util: { g: util.g, helpers: util.helpers },
  // `bbgm.api`'s real type lives inside the zengm checkout, which this repo
  // has no compile-time dependency on -- narrow, documented compatibility
  // cast (this file is not part of the tsc --noEmit include set anyway; see
  // the module doc comment above).
  api: bbgm.api as unknown as Parameters<
    typeof createBasketballGmAdapter
  >[0]["api"],
  constants: { PHASE, PLAYER, LEAGUE_DATABASE_VERSION },
  defaultGameAttributes,
  utils: { last },
  newLeague: { getDefaultSettings },
  createStreamFromLeagueObject,
  beforeView: { beforeLeague },
});

const handlers: Record<string, (params: any) => Promise<unknown>> = {
  create: async (params: { seed: string }) => {
    // Seeded once per worker, right before the episode that owns this
    // worker is created -- see bootstrap.ts's installSeededRandom doc
    // comment for why this keeps episodes' randomness isolated.
    installSeededRandom(params.seed);
    await adapter.create(params as Parameters<typeof adapter.create>[0]);
  },
  getRawState: async () => adapter.getRawState(),
  getOptions: async () => adapter.getOptions(),
  evaluateTrade: async (params) => adapter.evaluateTrade(params),
  executeTrade: async (params) => adapter.executeTrade(params),
  setLineup: async (params) => adapter.setLineup(params),
  releasePlayer: async (params) => adapter.releasePlayer(params),
  negotiateContract: async (params) => adapter.negotiateContract(params),
  signFreeAgent: async (params) => adapter.signFreeAgent(params),
  makeDraftPick: async (params) => adapter.makeDraftPick(params),
  advance: async (params) => adapter.advance(params),
  exportSnapshot: async () => adapter.exportSnapshot(),
  importSnapshot: async (params) => adapter.importSnapshot(params),
  close: async () => adapter.close(),
};

// Serialized command queue: every incoming message is chained onto the same
// promise, so exactly one engine mutation is ever in flight at a time, even
// if the host (EpisodeWorkerHost) posts several requests without waiting for
// responses in between. This is what prevents two concurrent mutations from
// interleaving against the same in-memory zengm Cache -- see
// docs/ENGINE_INTEGRATION.md ("serialized worker queue").
let queue: Promise<void> = Promise.resolve();

port.on("message", (request: Request) => {
  queue = queue.then(async () => {
    const response: Response = { id: request.id };
    try {
      const handler = handlers[request.method];
      if (!handler) throw new Error(`Unknown bridge method: ${request.method}`);
      console.error(`bbgm-bridge: ${request.method} start`);
      response.result = await handler(request.params);
      console.error(`bbgm-bridge: ${request.method} complete`);
    } catch (error) {
      const errorPayload: ResponseError =
        error instanceof Error
          ? error.stack !== undefined
            ? { message: error.message, stack: error.stack }
            : { message: error.message }
          : { message: String(error) };
      response.error = errorPayload;
      console.error(
        `bbgm-bridge: ${request.method} failed: ${errorPayload.message}`,
      );
    }
    port.postMessage(response);
  });
});
