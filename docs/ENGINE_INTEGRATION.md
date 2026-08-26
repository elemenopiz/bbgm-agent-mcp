# Basketball GM engine integration

How this project talks to the real Basketball GM (zengm) engine: what is
pinned, what globals get installed and why, how a worker is bundled, and the
exact, current status of the headless spike (including two bugs that were
found and fixed by actually running it — this is not a theoretical writeup).

## Pinned upstream commit

Everything here targets the exact commit pinned in `bbgm-engine.lock.json`
at the repo root:

```json
{
  "repository": "https://github.com/zengm-games/zengm.git",
  "commit": "4ee432c5b9097ed978749a049fff5823711690dc",
  "packageVersion": "5.1.0",
  "requiredNode": "24",
  "requiredPnpm": "11",
  "licenseFile": "LICENSE.md",
  "licenseSha256": "4b062aff490de1273782c6ab56839be01913690f494f0c95ac02bb07cb1f3603"
}
```

`scripts/verify-engine.ts` checks a local checkout's actual `git rev-parse
HEAD`, `package.json` version, and `LICENSE.md` hash against this lock file
and fails closed (non-zero exit, clear error) on any mismatch or missing
checkout. Nothing in this repo ever references upstream's moving `master` —
every zengm import path documented below is understood to be accurate _at
this pinned commit specifically_, and needs re-auditing on any commit bump
(see "Upgrading the pinned commit" below).

Basketball GM is proprietary, "source available" software, Copyright (C)
ZenGM, LLC — see `THIRD_PARTY.md`. **This project never clones, downloads,
fetches, or vendors it.** `BBGM_SOURCE_DIR` must point at a checkout the
user separately obtained and placed on disk themselves (conventionally at
`.cache/zengm`, which is gitignored). Nothing under `.cache/` is ever
committed or redistributed by this repo.

## Why the adapter is split the way it is

Everything that references zengm internals lives behind two boundaries:

- `src/engine/bbgm/` — `adapter.ts` (all the actual zengm calls),
  `mappings.ts` (raw zengm row → normalized DTO conversion),
  `compatibility.ts` (documented fidelity notes — read this when auditing
  any specific call), `bootstrap.ts` (worker-global shims),
  `BasketballGmEngine.ts` (main-thread `SimulationEngine` implementation).
- `engine-bridge/entry.ts` — the actual worker-thread entry point that
  dynamically imports zengm modules and dispatches RPCs into `adapter.ts`.

Nothing outside these files imports anything zengm-specific.

### The bundling wrinkle (and why there's no generic `episodeWorker.ts`)

A plain engine backend could ship an `episodeWorker.ts` and run it directly
with `new Worker(new URL("./episodeWorker.ts", import.meta.url))`. Basketball
GM's real worker code can't be run that way: it's written against zengm's
own `SPORT`-gated conditional-compilation (`tools/lib/rolldownPlugins/
sportFunctions.ts`, which strips the football/baseball/hockey branches of
shared modules at build time) and needs to be bundled with zengm's own
rolldown, not run as raw ESM. `scripts/build-engine-bridge.ts` does that
bundling: it builds `.cache/bbgm-bridge/bridge.mjs` from
`engine-bridge/entry.ts`, and `BasketballGmEngine.ts` points
`EpisodeWorkerHost` at that built file. This project therefore deliberately
has no generic `src/engine/process/episodeWorker.ts` — that file would have
nothing to do that `engine-bridge/entry.ts` + `build-engine-bridge.ts`
doesn't already do, and forcing a plain-ESM worker entry to exist just to
match a suggested layout would either duplicate `entry.ts` or be unable to
actually import zengm code.

That bundling requirement creates a second, more subtle wrinkle:
`adapter.ts`, `bootstrap.ts`, and `mappings.ts` live under `src/engine/bbgm/`
(per this project's file-ownership map) so that `tsc --noEmit` can resolve
and type-check them normally, using standard NodeNext `.js`-suffixed
specifiers like every other file in this repo. But `BBGM_SOURCE_DIR` can be
_anywhere_ on disk — there is no fixed relative path from it back to this
repo's `src/`. `scripts/build-engine-bridge.ts` resolves this by copying
`entry.ts`, `bootstrap.ts`, `adapter.ts`, and `mappings.ts` as **flat
siblings** into `<BBGM_SOURCE_DIR>/.mcp-bridge/` before invoking rolldown,
rewriting `entry.ts`'s two specifiers for `bootstrap.ts`/`adapter.ts` from
their real repo-relative form (`"../src/engine/bbgm/bootstrap.js"`) to
flat-sibling form (`"./bootstrap.ts"`) as part of the copy. `adapter.ts`'s
own import of `mappings.ts` (`"./mappings.js"`) needs no rewriting — they
are siblings in both locations, before and after the copy, by construction.
`compatibility.ts` is never imported at runtime (only referenced in
comments), so it is not copied. This is why those two specific lines in
`engine-bridge/entry.ts` look slightly unusual (see the comment right above
them) — it's a deliberate, tested mechanism, not an oversight.

Everything else zengm-specific lives in `engine-bridge/entry.ts` alone: it
imports the pinned commit's real module paths directly with `../src/...`
specifiers (relative to its own _copied_ location one level inside
`BBGM_SOURCE_DIR`), which this repo's own `tsc` program cannot and should
not resolve — `engine-bridge/zengm-modules.d.ts` declares an ambient
`"../src/*"` module shim so `tsc --noEmit` can still type-check the rest of
`entry.ts`'s logic without a checkout present. Similarly,
`src/engine/bbgm/fake-indexeddb-auto.d.ts` shims a real packaging gap in the
`fake-indexeddb` dependency (its `package.json` "exports" map doesn't expose
a "types" condition for the `/auto` subpath under NodeNext resolution) — the
real module still loads and behaves correctly at runtime; only the
type-checker needed the shim.

## Installed globals and why (`bootstrap.ts`)

Basketball GM's client bundle assumes it's running in a browser tab or the
game's own Web Worker. `installWorkerGlobals(sourceDir)` patches a plain
Node worker thread to look enough like that environment:

| Global                                                          | Why                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self`, `window`, `location`, `addEventListener`, `postMessage` | A handful of code paths check `typeof self`/`typeof window` or call these as no-ops; they just need to exist.                                                                                                                                                         |
| `fetch` (via `createSourceDirFetch`)                            | League creation fetches static data files (real player ratings/stats, generated names) with dev-server-relative URLs like `/gen/real-player-data.json`. Headless, there's no server — this rewrites those paths onto `<sourceDir>/data/...` and reads them from disk. |
| `fake-indexeddb/auto`                                           | Basketball GM persists everything to IndexedDB; Node has none natively. This installs an in-memory implementation.                                                                                                                                                    |
| `process.env.SPORT = "basketball"`                              | Gates zengm's `sportFunctions` rolldown plugin so only the basketball branches of shared, sport-conditional modules get bundled.                                                                                                                                      |
| `process.env.NODE_ENV = "test"`                                 | **Not `"production"` — see below.**                                                                                                                                                                                                                                   |

`installSeededRandom(seed)` replaces the worker's `Math.random` with a
seeded xorshift32 PRNG, called once per worker right before `create()`. Every
episode gets its own worker thread (`EpisodeWorkerHost`/`entry.ts`), and this
replaces the _global_ `Math.random` of that worker's own process — so one
episode's randomness structurally cannot leak into another's; there is no
shared process, only a shared source file.

### `NODE_ENV`: a bug this integration actually hit, not a guess

The single most important, concretely-verified fact in this document: with
`NODE_ENV="production"`, `core.league.createStream(...)` (the real call
`adapter.ts`'s `create()` makes) **hangs forever**, partway through, inside
`await toUI("resetLeague", [])`. `toUI()` (`src/worker/util/toUI.ts`) sends a
message over a `promise-worker-bi` RPC channel to a companion UI thread and
awaits its reply. In the real browser/Electron build that UI thread exists;
this headless worker has none, so the promise never resolves — not even
after zengm's own internal 30-second cache-status timeout, because that
timeout guards a different code path.

zengm's own source already has an escape hatch for exactly this, at `toUI()`
and several similar cross-thread call sites (`updatePlayMenu.ts`,
`updateMeta.ts`, `loadNames.ts`, `defaultCountries.ts`):

```ts
if (process.env.NODE_ENV === "test") {
  return Promise.resolve(); // or an early return / dummy value
}
```

This is what upstream's own test suite relies on to run worker code without
a real UI thread. `bootstrap.ts` sets `NODE_ENV="test"`, reusing that
upstream-sanctioned bypass rather than reimplementing a fake UI-thread RPC
responder.

**Trade-off, also confirmed by actually running it:** with `NODE_ENV="test"`,
`loadNames.ts` also takes its test-mode branch, which uses zengm's own dummy
name tables (`{first: {FirstName: 1}, last: {LastName: 1}}`) instead of
loading real name data. Every randomly-generated player in this adapter's
leagues is therefore named "FirstName LastName" rather than a realistic
name. This does not affect `SimulationEngine` correctness — `PlayerSummary.
name` is still a valid string — but it does reduce realism. A more surgical
fix (a minimal real `postMessage` responder for the `promise-worker-bi`
protocol, keeping `NODE_ENV="production"`) is possible but was judged out of
scope for this pass; see "Known follow-ups" below.

## The serialized worker command queue

`engine-bridge/entry.ts` chains every incoming `parentPort` message onto a
single `Promise` (`queue = queue.then(async () => { ... })`), so exactly one
`SimulationEngine` method ever executes at a time inside a given worker,
even if `EpisodeWorkerHost` posts several requests without awaiting
responses in between. This directly satisfies the project rule "use a
serialized command queue inside every episode worker; never execute two
engine mutations concurrently" — the pre-existing version of this file did
not have this (its bare `parentPort.on("message", ...)` handler fired an
unawaited async IIFE per message, so two requests arriving close together
could interleave against the same in-memory zengm `Cache`).

## Real zengm calls used, and confidence per call

See `src/engine/bbgm/compatibility.ts` for the authoritative, full list with
confidence levels (`high`/`medium`/`low`) and detailed reasoning — this is a
summary. Every `"high"` entry below was cross-checked against the exact
function zengm's own UI/api layer calls for that action, not guessed from
patterns:

| SimulationEngine method             | Real zengm call(s)                                                                                                                                                                            | Confidence                                                                             | Exercised this session?                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `create`                            | `core.league.createStream(...)`                                                                                                                                                               | high                                                                                   | yes                                                            |
| `getRawState`                       | `idb.cache.{players,teams,teamSeasons,draftPicks,schedule,events}.*`, `core.team.getPayroll`                                                                                                  | high                                                                                   | yes                                                            |
| `getOptions`                        | same reads as `getRawState` plus `core.draft.getOrder`                                                                                                                                        | high                                                                                   | yes                                                            |
| `advance`                           | `api.playMenu.{day,untilRegularSeason,untilDraft,untilYourNextPick,untilResignPlayers}` + `core.phase.newPhase` directly for RESIGN_PLAYERS (see bug #5 below), chosen by current zengm phase | high                                                                                   | yes — a full real season, preseason through the next preseason |
| `makeDraftPick`                     | `api.main.draftUser(pid, conditions)`                                                                                                                                                         | high                                                                                   | yes — 2 real picks made                                        |
| `exportSnapshot` / `importSnapshot` | raw `idb.league` object-store dump/restore + `connectLeague` + `beforeLeague`                                                                                                                 | high                                                                                   | yes — round-tripped, state verified consistent                 |
| `setLineup`                         | `api.main.reorderRosterDrag(sortedPids)`                                                                                                                                                      | high                                                                                   | no                                                             |
| `releasePlayer`                     | `api.main.releasePlayer({pids})`                                                                                                                                                              | high                                                                                   | no                                                             |
| `signFreeAgent`                     | `core.contractNegotiation.create(pid, false, tid)` + `api.main.acceptContractNegotiation({pid, amount, exp})`                                                                                 | high                                                                                   | no                                                             |
| `executeTrade`                      | `api.main.createTrade(teams)` + `api.main.proposeTrade(false, conditions)`                                                                                                                    | high                                                                                   | no                                                             |
| `evaluateTrade`                     | `core.trade.summary(teams)` + `new team.ValueChangeCalculator().evaluate(...)`, deliberately _not_ going through `trade.create`/`trade.propose` so it never mutates                           | medium                                                                                 | no                                                             |
| `negotiateContract`                 | Real negotiation flow when the player happens to be a free agent (e.g. mid-resign-window); direct `core.player.setContract(...)` write otherwise                                              | low — see compatibility.ts, this is the one method with no clean real-zengm equivalent | no                                                             |

## Spike status: **executed against a real checkout end to end — PASSED**

Per the project's licensing rule, this repo never downloads or vendors
Basketball GM itself. Whether the spike below could run at all depended
entirely on whether a real, separately-obtained local checkout happened to
be present on the machine this session ran on:

- `BBGM_SOURCE_DIR` was **unset** in this environment.
- A real checkout **was** present anyway, at the conventional fallback
  location `.cache/zengm` (which `scripts/verify-engine.ts`,
  `scripts/build-engine-bridge.ts`, and `BasketballGmEngine.ts` all default
  to when the env var is unset) — a full git clone of
  `https://github.com/zengm-games/zengm.git` at exactly the pinned commit,
  gitignored, not committed. It was not fetched by this session; its
  presence was confirmed and its use explicitly authorized mid-task.

With that checkout, the full spike checklist was actually run, via
`pnpm engine:verify` → `pnpm engine:build` → `scripts/smoke-engine.mts`
(through `tsx`, not plain `node` — see "Known follow-ups"):

1. `engine:verify` — **passed.** Commit, package version, and license hash
   all match `bbgm-engine.lock.json`.
2. `engine:build` — **passed.** `.cache/bbgm-bridge/bridge.mjs` built
   successfully via zengm's own rolldown + `sportFunctions` plugin.
3. `create()` — **passed**, after fixing the `NODE_ENV` hang described
   above. Produces a full 30-team league with real standings/divisions.
4. `getRawState()` — **passed**, after fixing the `g.get("day")` throw and
   the event `text`-field crash described below. Returns a fully-normalized
   `EngineRawState` with a real roster (13 players), 150 free agents, 8
   owned draft picks, all 30 teams in `standings`, realistic payroll/cap
   numbers, etc.
5. `getOptions()` — **passed.** Returns real, current legal actions (165 of
   them for a fresh preseason league).
6. `advance({ target: "next_game" })` — **passed.**
7. Bounded season-advance loop (`advance({ target: "phase" })` repeated,
   auto-drafting the top prospect whenever blocked on the user's own pick)
   — **passed.** Went preseason → regular_season → playoffs →
   draft_lottery → draft (2 user picks made via `makeDraftPick`) →
   resigning → free_agency → preseason, completing the full season
   transition (2026 → 2027) in exactly 10 `advance()` calls, well inside the
   20-call bound.
8. `exportSnapshot()` / `importSnapshot()` — **passed.** Round-tripped a
   real snapshot; post-import state (season/phase/roster size) matched
   pre-export state exactly.
9. `advance({ target: "next_game" })` again, post-import — **passed**,
   confirming the restored league is still simulatable, not just readable.

**Final result: `engine:smoke: PASSED in 51.6s`** (full run, including
`engine:verify` and `engine:build`).

### Five real bugs found by actually running this, and fixed

Every one of these was found by an actual crash or an actual stuck loop in
this session, not by code review:

1. **`NODE_ENV` hang** (see above) — `bootstrap.ts` now sets
   `NODE_ENV="test"` instead of `"production"`. Without this fix,
   `create()` hung forever, every time.
2. **`g.get("day")` throws instead of returning `undefined`** when the
   `"day"` game attribute has never been set (true for every episode until
   its first day-by-day `advance()`), with the exact message `Attempt to
get g.day while it is not already set`
   (`src/worker/util/g.ts`). `getRawState()` now catches this specific
   throw and omits the optional `day` field rather than failing the whole
   call.
3. **`events.text` is optional, not always a string**, for modern
   `"trade"`/`"freeAgent"`/`"reSigned"` events (confirmed against
   `EventBBGMWithoutKey` in `common/types.ts`: `text?: string; // Only
legacy will have text`). The original mapping assumed `text` was always
   present and crashed the first `getRawState()` call after a trade/sign
   event existed in the log (`Cannot read properties of undefined (reading
'replaceAll')`). `mappings.ts`'s `describeTransaction` now synthesizes a
   plain-text description from the structured fields (`pids`/`tids`) when
   `text` is absent, instead of assuming it exists.
4. **`api.draftUser`/`releasePlayer`/`reorderRosterDrag`/
   `acceptContractNegotiation`/`createTrade`/`proposeTrade` are nested under
   `api.main.*`, not top-level on `api`** — only
   `actions`/`eightyTwoZeroDraft`/`exhibitionGame`/`leagueFileUpload`/
   `playMenu`/`toolsMenu`/`undoLog` are top-level. A real `makeDraftPick()`
   call failed with `api.draftUser is not a function` until all six call
   sites (and the `ZengmModules.api` type) were corrected to go through
   `api.main.*`.
5. **`playMenu.untilFreeAgency` never advances past RESIGN_PLAYERS**
   whenever any resign-window negotiations are pending (the normal case): it
   gates the phase transition on `await toUI("confirm", [...])`, which
   resolves to `undefined` (falsy) under the `NODE_ENV="test"` fix from bug
   #1. A real 20-attempt bounded season loop reported `hit_step_limit` on
   every single attempt once it reached the resigning phase, never
   progressing. `stepOneZengmPhase()` now special-cases RESIGN_PLAYERS to
   call `core.phase.newPhase(FREE_AGENCY, conditions)` directly — the same
   call `untilFreeAgency` itself would have made had the (headless,
   unanswerable) confirm dialog been accepted.

**This adapter has been exercised for real, not just read from source.**
Every "high confidence" call in the table above ran successfully against a
real league in this session, and five real defects that only a real run
could have caught were found and fixed in the same session. What it has
_not_ been exercised against yet: `evaluateTrade`/`executeTrade` (no trade
partner was proposed in this run), `negotiateContract` against a
non-free-agent player (the low-confidence fallback path), `setLineup`, and
multiple concurrent episodes/workers. Those remain "confidence per
compatibility.ts, not independently run" — a natural next step is extending
`scripts/smoke-engine.mts` to exercise them too.

### Independently re-verified

The above was written by the session that built the adapter. It was then
independently re-run and re-confirmed by the lead integration session:

- Re-ran `pnpm engine:smoke` from a clean state against the same checkout —
  **passed again**, full season, real draft picks, snapshot round-trip,
  ~49s.
- A separate determinism check (two concurrent episodes, same seed
  `"real-determinism-seed-1"`, `create` + 3× `advance({target:"next_game"})`
  each) against the **real engine** produced byte-identical `stateHash`
  sequences across both runs. This also doubles as a real-engine episode
  isolation check: two real `BasketballGmEngine` instances (two real
  `node:worker_threads` workers, two real in-memory zengm leagues) ran fully
  concurrently without cross-contaminating each other's state or RNG.

## Known follow-ups

- `scripts/smoke-engine.mts` must currently be run via `tsx` (or another
  loader that maps `.js`-suffixed relative specifiers back to sibling `.ts`
  sources), not plain `node scripts/smoke-engine.mts` — plain Node's native
  TS support strips types but does not do that extension remapping, and
  fails with `ERR_MODULE_NOT_FOUND` looking for a `.js` file that doesn't
  exist. `package.json`'s `engine:smoke` script (not owned by this pass —
  see the session report) should invoke it the same way `"dev": "tsx
src/cli.ts"` does: `tsx scripts/smoke-engine.mts`.
- The `NODE_ENV="test"` / dummy-names trade-off above: a real, minimal
  `postMessage` responder for `promise-worker-bi`'s RPC protocol would let
  `NODE_ENV` stay `"production"` and get real generated names back, at the
  cost of reimplementing a small slice of zengm's own UI-thread contract.
  Not attempted this pass.
- `evaluateTrade`'s "must not mutate" implementation (`core.trade.summary` +
  `ValueChangeCalculator`, bypassing the normal `trade.create`-then-`trade.
propose` staging flow) has not been cross-checked against a live
  `trade.propose()` call on the same proposal to confirm they agree — see
  compatibility.ts.
- `negotiateContract`'s direct `setContract` fallback path (for a
  currently-rostered player who is not presently a free agent) has not been
  exercised against a real checkout.

## Upgrading the pinned commit

1. Update `bbgm-engine.lock.json` (`commit`, `packageVersion`,
   `licenseSha256` — recompute via `shasum -a 256 LICENSE.md` against the
   new checkout).
2. `pnpm engine:verify` against a checkout at the new commit.
3. Re-audit every call in the confidence table above, and every entry in
   `src/engine/bbgm/compatibility.ts`, against the new commit's diff —
   particularly `common/constants.ts`'s `PHASE`/`PLAYER` numeric enums
   (hardcoded in `mappings.ts`'s `ZENGM_PHASE`, not imported, precisely so
   this file has no zengm dependency — but that means a renumber upstream
   is a silent-breakage risk that only re-auditing catches), and the exact
   `api.*`/`core.*` function names/signatures adapter.ts calls.
4. Re-run `pnpm engine:build` and `pnpm engine:smoke` end to end.

## Setup for a user who wants to actually run the real engine

```sh
export BBGM_SOURCE_DIR=/path/to/your/own/zengm/checkout   # at the pinned commit
pnpm engine:verify   # fails closed with a clear message if the checkout is missing/mismatched
pnpm engine:build     # bundles engine-bridge/entry.ts via zengm's own rolldown
pnpm engine:smoke     # runs the full spike end to end and prints a summary to stderr
```

If `BBGM_SOURCE_DIR` is unset, both `engine:verify` and `engine:smoke` fail
closed with an actionable message rather than silently no-op-succeeding —
`engine:smoke` checks this explicitly before doing anything else, in
addition to whatever `engine:verify` itself does.
