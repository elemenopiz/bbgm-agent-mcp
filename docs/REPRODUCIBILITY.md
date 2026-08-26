# Reproducibility

This document is the precise statement of what determinism guarantee this
environment gives you, what it does not, and how to actually reproduce an
episode from its recorded artifacts. Read this before treating any state
hash as a proof of anything across environments.

## What state hashes are

Every observation and mutation response includes a `stateHash`: a SHA-256
hex digest of the canonical JSON of `{ revision, state }`
(`src/domain/stateHash.ts::stateHash`, called as
`this.computeStateHash(record.revision, state)` throughout
`DomainService`). "Canonical" means object keys are recursively sorted
before serialization, so `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` hash
identically — key order in the engine's own output can't cause a spurious
mismatch.

Deliberately **excluded** from the hash: wall-clock timestamps
(`TrajectoryRecord.timestamp` is recorded separately, "for audit only;
never used in stateHash or any determinism comparison" per its own
docstring), filesystem paths, and `episodeId` itself (the hash is over
`state`, the engine's own `EngineRawState`, plus the numeric `revision` —
not over anything wrapper-assigned that would differ between two otherwise
identical runs).

## What IS deterministic

Given:

1. the same Basketball GM engine commit (recorded in every trajectory
   record's `engine.commit`, and pinned in `bbgm-engine.lock.json`),
2. the same episode seed, and
3. the same sequence of normalized actions applied at the same revisions,

the resulting sequence of state hashes is deterministic — replaying that
exact sequence against that exact engine commit reproduces the exact same
`stateHash` at every step. This holds by construction: `create()` seeds the
engine's own RNG from the episode seed (in the real-engine bridge,
`hashSeed(seed)` feeding a seeded xorshift generator that overrides
`Math.random` for that worker's isolated global scope — see
[docs/ARCHITECTURE.md](ARCHITECTURE.md#episode-isolation-model)), and every
subsequent state transition is a pure function of the current engine state
plus the applied action.

## What is NOT guaranteed bit-for-bit stable

State hashes are **not** guaranteed to reproduce across:

- **Different Node.js versions.** Floating-point formatting, `Date`
  behavior, and V8 internals can differ across major versions even when
  application code is unchanged.
- **Different pinned zengm commits.** Any engine code change — including
  ones that look purely cosmetic — can change simulated outcomes, since the
  engine's own RNG consumption order and game-logic internals are opaque to
  this wrapper.
- **Different wrapper versions.** A change to normalization, schema
  defaults, or even the shape of `EngineRawState` fields the hash is
  computed over changes the hash, independent of the engine underneath.

This is exactly why all three are recorded, explicitly and per-step, rather
than assumed constant for a whole run:

- `TrajectoryRecord.engine` — `{ name, version, commit? }`, taken from the
  live engine's own `metadata` at the time of the call.
- `TrajectoryRecord.wrapperVersion` — `WRAPPER_VERSION` from
  `src/version.ts`, kept in sync with `package.json#version`.
- `EpisodeMetadata.engine` — the same engine metadata, recorded once at
  episode creation.

A reproduction attempt should treat a hash mismatch across two runs whose
recorded `engine.commit` or `wrapperVersion` differ as **inconclusive, not
a bug** — the runs weren't reproducing the same thing to begin with. A hash
mismatch between two runs with _matching_ commit, wrapper version, and Node
major version, given the same seed and same action sequence, is a genuine
determinism regression worth investigating.

## Reproducing an episode from its manifest and trajectory log

Every episode's trajectory is an append-only JSONL file at
`.data/episodes/<episodeId>/trajectory.jsonl` (see
[README.md](../README.md#data-storage-and-cleanup)), one `TrajectoryRecord`
per `create_episode` / `mutation` / `end_episode` step, each carrying:
`sequence`, `revision`, `toolName`, `args`, `preStateHash`, `postStateHash`,
`normalizedAction`, `events`, `invariantResults`, `engine`,
`wrapperVersion`, and `latencyMs` (timing only — never part of any
determinism check).

To reproduce an episode:

1. **Match the environment.** Confirm the reproduction machine has the same
   Node major version, the same wrapper version (or at least a version with
   no changes affecting `src/domain/`), and a checkout of the exact engine
   commit recorded in the trajectory's `engine.commit` field — run
   `pnpm engine:verify` against it.
2. **Re-create the episode** with the same `scenarioId`, `seed`, and
   `userTeamId` from either the original scenario manifest or the
   `create_episode` trajectory record's `args`. This should reproduce the
   first record's `postStateHash`.
3. **Replay the same tool calls, in the same order, with the same
   normalized actions**, reading each subsequent trajectory record's
   `toolName` and `normalizedAction` (not the raw MCP `args`, which may
   include incidental fields like a caller-chosen `idempotencyKey` that
   don't affect engine behavior — `normalizedAction` is the
   engine-semantics-relevant part, e.g. `{ type: "release_player", pid }`).
   Use `expectedRevision` values that match the record's own `revision`
   sequence, not values from a diverged run.
4. **Compare `stateHash` at each step**, not just at the end. Comparing
   only the final hash conflates "diverged on step 3 but ended up in the
   same place" with true reproduction, and — more importantly — hides
   _where_ a divergence started, which is exactly the information you need
   to tell a genuine non-determinism bug apart from a replay mistake (wrong
   action order, stale revision, or a version mismatch per the section
   above).

Because checkpoints (`bbgm_checkpoint(action="create")`) capture a full
importable engine snapshot at a given revision, they can also be used to
resume reproduction from partway through an episode rather than always
replaying from `create_episode` — restore the checkpoint, then continue
replaying from the trajectory record immediately after it.
