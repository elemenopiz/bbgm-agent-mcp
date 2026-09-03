# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it reaches a stable public interface.

## [Unreleased]

Initial build of the research environment. Nothing has been tagged as a
release yet; the current package version is `0.1.0`.

### Added

- **Grant evidence verification**: append-only attempt telemetry, explicit
  rollback trajectory nodes, a fail-closed evidence verifier, and a canonical
  five-seed grant-demo bundle with reviewer summary output.
- **Domain contract** (`src/domain/`): transport-independent `SimulationEngine`
  interface, typed episode/state/mutation shapes, Zod v4 schemas for every
  tool input/output, canonical-JSON SHA-256 state hashing, built-in
  invariant checks (roster size, duplicate ownership, contract validity,
  cap compliance, finite values, season progression, lineup validity), and
  a `DomainService` that enforces mutation legality, per-episode
  revision/idempotency bookkeeping, rollback-on-invariant-failure, and
  trajectory logging in one place shared by both the MCP tool layer and the
  offline research/evaluation layer.
- **MCP tool catalog**: 16 `bbgm_*` tools covering episode lifecycle
  (create/end), observation (`get_state` with 10 bounded, paginated views,
  including any team's public roster via an optional `teamId` -- needed to
  actually construct a trade proposal; `get_options`), trade evaluation and
  execution, roster/contract management (lineup, release, contract
  negotiation, free-agent signing, draft picks), simulated-time
  advancement, and checkpointing (create/list/restore).
- **Episode isolation** (`src/sessions/`): an `EpisodeManager`/`EpisodeStore`
  that gives each episode its own engine instance and a serialized
  per-episode command queue, so concurrent tool calls against the same
  episode never race, and a crash or slowdown in one episode cannot affect
  another.
- **Persistence layer** (`src/persistence/`): atomic (write-temp-then-rename)
  checkpoint snapshots and an append-only, per-episode JSONL trajectory log
  recording every create/mutation/end step with pre/post state hashes,
  applied actions, engine events, invariant results, and engine/wrapper
  version metadata.
- **Engine integration** (`src/engine/`, `engine-bridge/`, `scripts/`): a
  `BasketballGmEngine` implementation that runs the real, headless
  Basketball GM engine inside an isolated worker thread (one per episode,
  via the generic `EpisodeWorkerHost`), a message-passing bridge entry
  point with a serialized per-worker command queue, a build script that
  bundles the bridge against a user-supplied zengm checkout via zengm's own
  rolldown, and a verification script that checks the checkout's commit,
  package version, license hash, and Node version against
  `bbgm-engine.lock.json` before anything is allowed to run against it.
  Actually executed end to end against a real, separately-obtained zengm
  checkout via `pnpm engine:smoke` and a gated real-engine integration test
  suite (`tests/integration/realEngine.test.ts`, `BBGM_REAL_ENGINE=1`):
  league creation, a full simulated season (including real user draft
  picks), a real trade an actual opponent AI accepted, roster/contract
  moves (lineup, release, sign, contract negotiation), reading another
  team's roster, snapshot export/import, checkpoint restore, and a
  determinism check across concurrent real episodes — every
  `SimulationEngine` method has at least one real, live, passing exercise
  on record. See `docs/ENGINE_INTEGRATION.md` for the full account,
  including seven real bugs found and fixed by those runs (not by code
  review).
- **Research/evaluation layer** (`src/research/`): scenario manifests (seed
  sets, horizon, hard constraints/soft objectives, allowed information and
  actions, step budget), a `no_op` and a deterministic `heuristic` baseline
  policy, raw metric components (win rate, asset value, constraint
  satisfaction, invalid-action rate, tool-call efficiency, and more) plus
  configurable scalar-reward and lexicographic/Pareto comparison modes, and
  a `research:evaluate` CLI entry point that calls `DomainService` directly,
  bypassing MCP, so scripted evaluation runs and an LLM agent share
  identical mutation semantics.
- **Repository documentation and hygiene**: architecture, tool catalog,
  research protocol, and reproducibility docs under `docs/`; expanded
  third-party licensing disclosure; a wrapper-only MIT license; contributor
  guide; and a GitHub Actions CI workflow (format, lint, typecheck, test,
  build — engine-independent only).

### Changed

- **Real-engine snapshot fidelity**: transaction history is read from the
  durable Basketball GM events store after restore, preserving exact state
  hashes through rollback and restart; the real-engine smoke test now checks
  the complete canonical state hash across snapshot round trips.
- **CI/release evidence**: hosted CI now uses the repository's `.nvmrc`, the
  exact pnpm version declared by `package.json`, read-only repository
  permissions, superseded-run cancellation, an explicit real-engine skip
  boundary, and a tracked-file cleanliness check after the build.
- Added the grant-facing [release checklist](docs/RELEASE_CHECKLIST.md),
  including the pinned-engine/license boundary, reproducibility metadata,
  artifact-hygiene checks, versioning discipline, and required
  `research-preview` labeling. No public release is claimed by this entry.
