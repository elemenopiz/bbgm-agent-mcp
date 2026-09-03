# bbgm-agent-mcp

An MCP (Model Context Protocol) server that lets an LLM act as the general
built as a safety research environment for studying reward hacking,
oversight-sensitive behavior, and narrow-fine-tuning drift in stateful,
long-horizon tool use.

Basketball GM is the controlled testbed, not the research claim. The active
grant framing and implementation priorities are in
[`docs/SAFETY_GRANT_STRATEGY.md`](docs/SAFETY_GRANT_STRATEGY.md).

## What this is, and is not

- This is a research **adapter**: it wraps a separately obtained Basketball
  GM / zengm source checkout in a typed MCP tool surface, episode isolation,
  invariant checking, and trajectory logging, so an LLM agent (or an offline
  evaluation harness) can play seasons of GM decisions in a reproducible way.
- This is **not** a general basketball simulation product, and it is not a
  way to play or distribute Basketball GM as a game.
- This project is **not affiliated with, endorsed by, or sponsored by ZenGM,
  LLC** or the Basketball GM / zengm project.
- This project does **not** grant you rights to Basketball GM. It does not
  vendor, redistribute, or relicense the engine. See
  [THIRD_PARTY.md](THIRD_PARTY.md) and [LICENSE-WRAPPER.md](LICENSE-WRAPPER.md).

> **Engine license warning.** Basketball GM is source-available, **not open
> source**. Its license permits local private execution and source sharing
> under its own terms, while restricting hosting and redistributable
> installers. You must obtain your own Basketball GM / zengm checkout and
> agree to its license before pointing this wrapper at it — this repository
> deliberately does not download, vendor, or bundle that checkout for you.
> Read the upstream `LICENSE.md` before proceeding:
> <https://github.com/zengm-games/zengm/blob/master/LICENSE.md>

## Architecture, in one paragraph

An MCP tool call is validated against a Zod schema, then handled by a thin
tool registration that delegates to a single `DomainService`, which is the
one place mutation legality, per-episode revision/idempotency bookkeeping,
post-mutation invariant checks with rollback, and trajectory logging happen.
`DomainService` talks to episodes through a transport-independent
`SimulationEngine` interface; in production every episode gets its own
`BasketballGmEngine` instance running the real engine inside an isolated
`node:worker_threads` worker, while a `FakeSimulationEngine` implements the
same interface in-process for fast, deterministic unit tests. A
research/evaluation layer can call `DomainService` directly, bypassing MCP
entirely, so scripted experiments and an LLM agent see identical semantics.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full breakdown of
layers and the request/mutation state-flow diagram.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 11 (`packageManager` is pinned in `package.json`; enable it with
  `corepack enable` if `pnpm` isn't already on your `PATH` at that version)
- A separately obtained Basketball GM / zengm source checkout for the real
  engine. This wrapper does **not** download or vendor it for you — see the
  license warning above. The commit and version this wrapper is pinned
  against are recorded in [`bbgm-engine.lock.json`](bbgm-engine.lock.json).

## Setup

```sh
nvm use
corepack enable
pnpm install
```

Point the wrapper at your own Basketball GM / zengm checkout, then verify it
matches the commit, package version, and license file this wrapper is
pinned against:

```sh
export BBGM_SOURCE_DIR=/absolute/path/to/your/zengm-checkout
pnpm engine:verify
```

`engine:verify` (`scripts/verify-engine.ts`) checks, in order: the checked-out
git commit against `bbgm-engine.lock.json#commit`, the checkout's
`package.json#version` against `#packageVersion`, a SHA-256 of the upstream
`LICENSE.md` against `#licenseSha256`, and the running Node major version
against `#requiredNode`. Any mismatch fails loudly rather than silently
running against an unverified engine.

Build the headless bridge that lets the real engine run inside a worker
thread:

```sh
pnpm engine:build
```

This bundles `engine-bridge/entry.ts` together with the zengm checkout's own
build tooling (it imports `rolldown` and the sport-functions plugin from
`BBGM_SOURCE_DIR/node_modules`, so `pnpm install` must already have been run
inside that checkout) into `.cache/bbgm-bridge/bridge.mjs`.

## Build and test

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run (engine-independent unit/contract tests)
pnpm build       # tsc -p tsconfig.build.json -> dist/
pnpm check       # format:check && typecheck && test && build
```

Tests that need the real engine are gated behind `BBGM_REAL_ENGINE=1` and a
valid `BBGM_SOURCE_DIR`; they are skipped by default. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full test taxonomy.

## Running the server

The published entry point is the `bbgm-agent-mcp` bin
(`dist/cli.js`), which speaks MCP over stdio. For local development:

```sh
pnpm dev
```

### Pointing an MCP host at it

Any MCP-compatible client that can launch a stdio subprocess can use this
server. The generic shape of an `mcpServers` config block (the format used
by, for example, Claude Desktop and Claude Code) is:

```json
{
  "mcpServers": {
    "bbgm-agent-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/bbgm-agent-mcp/dist/cli.js"],
      "env": {
        "BBGM_SOURCE_DIR": "/absolute/path/to/your/zengm-checkout"
      }
    }
  }
}
```

Run `pnpm build` first so `dist/cli.js` exists. Consult your specific
client's documentation for where this config block lives — the block's
shape is broadly consistent across clients, but the file location and
surrounding keys are not standardized by the MCP spec itself.

## Research evaluation

The offline evaluator calls the same `DomainService` used by MCP, so protocol
overhead does not change environment semantics. Scenario manifests can choose
the comparison mode:

```json
{
  "reward": {
    "mode": "lexicographic",
    "order": ["hard_constraints_satisfied_at_end", "win_pct"]
  }
}
```

Use `mode: "scalar"` with `weights` for a weighted signal, or
`mode: "pareto"` with `keys` for a frontier. The report preserves raw metric
components, the declared reward configuration, per-run reward data, and the
deterministic comparison artifact. Pass `--policy all` to run both shipped
reference policies (`no_op` and `heuristic`) over the selected seed set.

## Tool overview

The server exposes 16 tools, all prefixed `bbgm_`. Mutating tools require
`episodeId`, `expectedRevision` (optimistic-concurrency check), and
`idempotencyKey` (safe retries); `bbgm_create_episode` and `bbgm_end_episode`
are the two exceptions — see [docs/TOOL_CATALOG.md](docs/TOOL_CATALOG.md)
for full input/output shapes, MCP annotations, and error codes.

| Tool                      | Kind                       | Purpose                                                                                                                                    |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bbgm_create_episode`     | mutating (not destructive) | Start an isolated, seeded episode; returns the initial overview state                                                                      |
| `bbgm_resume_episode`     | lifecycle                  | Rehydrate a persisted episode after a process restart                                                                                      |
| `bbgm_get_state`          | read-only                  | Read a bounded, paginated view of league state (`draft` includes the complete current-owner pick ledger plus the user's owned-pick subset) |
| `bbgm_get_options`        | read-only                  | List legal action categories and candidate IDs for the current phase/revision                                                              |
| `bbgm_evaluate_trade`     | read-only (dry run)        | Check a proposed trade's legality, payroll/roster effects, and opponent acceptance without mutating                                        |
| `bbgm_execute_trade`      | mutating                   | Execute a previously evaluated, legal trade                                                                                                |
| `bbgm_set_lineup`         | mutating                   | Set the roster's depth-chart order                                                                                                         |
| `bbgm_release_player`     | mutating                   | Waive a rostered player to free agency                                                                                                     |
| `bbgm_negotiate_contract` | mutating                   | Extend/renegotiate a rostered player's contract                                                                                            |
| `bbgm_sign_free_agent`    | mutating                   | Sign an available free agent to a contract                                                                                                 |
| `bbgm_make_draft_pick`    | mutating                   | Select an available prospect with an owned pick (draft phase only)                                                                         |
| `bbgm_advance`            | mutating                   | Advance simulated time to a bounded target, including named milestones such as the trade deadline, draft, and offseason decision windows   |
| `bbgm_create_checkpoint`  | non-destructive lifecycle  | Persist an opaque checkpoint of the current episode state                                                                                  |
| `bbgm_list_checkpoints`   | read-only                  | List opaque checkpoints created for the episode                                                                                            |
| `bbgm_restore_checkpoint` | mutating                   | Restore a checkpoint while advancing the revision                                                                                          |
| `bbgm_end_episode`        | mutating (terminal)        | Finalize an episode, compute terminal metrics, close its worker                                                                            |

## Minimal episode walkthrough

The following is an **illustrative, hand-written example**, not a captured
or tested transcript. Field values are plausible but fabricated; consult
[docs/TOOL_CATALOG.md](docs/TOOL_CATALOG.md) for the authoritative schemas.

**1. Create an episode**

```jsonc
// call: bbgm_create_episode
{
  "scenarioId": "rebuild-2026",
  "seed": "20260825-01",
  "userTeamId": 0,
  "startingSeason": 2026,
  "constraints": {
    "hard": [
      { "code": "CAP_COMPLIANCE", "description": "Stay under the salary cap" },
    ],
    "soft": [
      {
        "code": "MAXIMIZE_WINS",
        "description": "Maximize regular-season wins",
        "weight": 1,
      },
    ],
  },
}
// -> overview view, e.g. { "episodeId": "e_9f2a...", "revision": 0, "phase": "preseason", "nextDecision": "advance_phase", ... }
```

**2. Look at the situation**

```jsonc
// call: bbgm_get_state { "episodeId": "e_9f2a...", "view": "overview" }
```

**3. See legal options**

```jsonc
// call: bbgm_get_options { "episodeId": "e_9f2a..." }
// -> { "revision": 0, "options": [{ "type": "advance", "target": "next_game" }, ...] }
```

**4. See what a prospective trade partner actually has**

```jsonc
// call: bbgm_get_state { "episodeId": "e_9f2a...", "view": "roster", "teamId": 7 }
// -> a "roster" view of team 7's players (teamId: 7), not the user's own
```

**5. Dry-run a trade before committing to it**

```jsonc
// call: bbgm_evaluate_trade
{
  "episodeId": "e_9f2a...",
  "proposal": {
    "otherTeamId": 7,
    "offered": [{ "type": "player", "pid": 1042 }],
    "requested": [{ "type": "draft_pick", "dpid": 305 }],
  },
}
// -> { "legal": true, "acceptedByOtherTeam": true, "payrollDelta": -4.2, ... }
```

**6. Execute it, using the revision from step 2/3 and a fresh idempotency key**

```jsonc
// call: bbgm_execute_trade
{
  "episodeId": "e_9f2a...",
  "expectedRevision": 0,
  "idempotencyKey": "trade-e_9f2a-001",
  "proposal": {
    "otherTeamId": 7,
    "offered": [{ "type": "player", "pid": 1042 }],
    "requested": [{ "type": "draft_pick", "dpid": 305 }],
  },
}
// -> mutationResult with revision: 1
```

**7. Advance to the next game**

```jsonc
// call: bbgm_advance
{
  "episodeId": "e_9f2a...",
  "expectedRevision": 1,
  "idempotencyKey": "advance-e_9f2a-001",
  "target": "next_game",
}
// -> mutationResult with revision: 2
```

**8. Checkpoint before something risky**

```jsonc
// call: bbgm_create_checkpoint { "episodeId": "e_9f2a..." }
// -> { "checkpoint": { "checkpointId": "c_71bd...", "revision": 2, ... } }
```

**9. End the episode when the scenario horizon is reached**

```jsonc
// call: bbgm_end_episode { "episodeId": "e_9f2a...", "exportFinalSnapshot": true }
// -> { "finalState": {...}, "terminalMetrics": { "seasonsCompleted": 0, "finalRecord": {...}, ... } }
```

## Troubleshooting

**`pnpm engine:verify` fails.** The error names exactly which check failed:
a commit mismatch means `BBGM_SOURCE_DIR` isn't checked out at the commit
pinned in `bbgm-engine.lock.json`; a package-version or license-hash
mismatch means the checkout diverged from what was verified when the lock
file was written; a Node-version mismatch means you're not running the
pinned major version. Fix the checkout (or, if you are deliberately bumping
the pinned engine version, update `bbgm-engine.lock.json` to match and
re-verify) rather than bypassing the check.

**Stdio / stdout pollution.** MCP-over-stdio requires stdout to contain
_only_ JSON-RPC protocol frames. All logging in this codebase writes to
stderr exclusively (see `src/logging/logger.ts`), and the engine bridge does
the same via `console.error` (see `engine-bridge/entry.ts`). If an MCP host
reports malformed JSON-RPC or the connection silently hangs, look for any
stray `console.log` / `process.stdout.write` — in your own code, in a
dependency, or (most likely) inside the bundled Basketball GM bridge if you
modify `engine-bridge/entry.ts`.

**Worker crashes.** The real engine runs inside a dedicated
`node:worker_threads` `Worker` per episode (`BasketballGmEngine`). A worker
`error` event rejects every in-flight call for that one episode; because
isolation is per-episode, other active episodes are unaffected. A crashed
episode's tool calls surface as `ENGINE_ERROR` (or `TIMEOUT` if the worker
never responds). Check stderr for the worker's error message and stack, and
for `bbgm-bridge:` prefixed lines from `engine-bridge/entry.ts` showing which
bridge method was in flight when it died.

**No real Basketball GM checkout available.** This wrapper never fetches one
on its own — that is intentional, not a bug, given the engine's licensing
terms. If you only need protocol-level or domain-logic testing, run against
`FakeSimulationEngine` (used automatically by the unit test suite under
`tests/`) rather than pointing `BBGM_SOURCE_DIR` at anything.

## Data storage and cleanup

Episode data is written under a data root that defaults to `.data/` in the
project root (already gitignored). Per episode, this holds:

```
.data/episodes/<episodeId>/trajectory.jsonl       # append-only log, including explicit rollback audit nodes
.data/episodes/<episodeId>/checkpoints/<id>.json   # snapshots created by bbgm_create_checkpoint
.data/episodes/<episodeId>/final-snapshot.json     # written by bbgm_end_episode when exportFinalSnapshot is true
```

To reclaim disk space or start fresh, it is always safe to remove the whole
data root — nothing under it is required for the wrapper itself to run,
only for resuming or auditing past episodes:

```sh
rm -rf .data/episodes/<episode-id>
```

## Research reproducibility caveats

State hashes are deterministic given the same engine commit, the same
wrapper version, the same seed, and the same sequence of normalized actions
— but they are **not** guaranteed bit-for-bit stable across different Node
versions, different pinned zengm commits, or different wrapper versions.
All three are recorded in every trajectory record and in episode metadata
specifically so a reproduction attempt can check for a version match before
trusting a hash comparison. See
[docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) for the full model and
[docs/RESEARCH_PROTOCOL.md](docs/RESEARCH_PROTOCOL.md) for how scenarios,
metrics, and baselines are meant to be used in evaluation work.

## Licensing

The wrapper and research code in this repository are MIT-licensed — see
[LICENSE-WRAPPER.md](LICENSE-WRAPPER.md). That license does **not** extend
to Basketball GM / zengm, which is a separate, source-available dependency
under its own, more restrictive terms. See [THIRD_PARTY.md](THIRD_PARTY.md).
