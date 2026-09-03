# Reproducibility

This document is the precise statement of what determinism guarantee this
environment gives you, what it does not, and how to actually reproduce an
episode from its recorded artifacts. Read this before treating any state
hash as a proof of anything across environments.

## What state hashes are

Every `bbgm_get_state` view and mutation response includes a `stateHash`: a
SHA-256 hex digest of the canonical JSON of `{ revision, state }`
(`src/domain/stateHash.ts::stateHash`, called as
`this.computeStateHash(record.revision, state)` throughout
`DomainService`). "Canonical" means object keys are recursively sorted
before serialization, so `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` hash
identically — key order in the engine's own output can't cause a spurious
mismatch.

`bbgm_get_options` is revision-stamped but has no `stateHash`; it is a
candidate/action view, not a state-hash observation. The append-only
trajectory and attempt logs provide the corresponding audit records.

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
2. the same wrapper source/version and compatible Node runtime (the exact
   values should be retained in provenance),
3. the same initial conditions, including the exact initial snapshot bytes
   when `initialSnapshotPath` is used,
4. the same episode seed, and
5. the same sequence of normalized state-changing actions applied at the same
   revisions,

the resulting sequence of state hashes is deterministic — replaying that
exact sequence against that exact engine commit reproduces the exact same
`stateHash` at every step. This holds by construction: the real-engine bridge
seeds the worker's RNG immediately before `create()` using
`hashSeedToUint32(seed)` and the `xorshift32-v1` generator, which overrides
`Math.random` for that worker's isolated global scope (see
[docs/ARCHITECTURE.md](ARCHITECTURE.md#episode-isolation-model)). Every
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
- **Different wrapper versions or source revisions.** A change to normalization, schema
  defaults, or even the shape of `EngineRawState` fields the hash is
  computed over changes the hash, independent of the engine underneath.

- **Different initial snapshots.** A snapshot changes the starting engine
  state and, for real-engine snapshots, carries the seeded RNG state used for
  deterministic continuation.

This is exactly why the engine and wrapper identity are recorded explicitly
and per-step, rather than assumed constant for a whole run:

- `TrajectoryRecord.engine` — `{ name, version, commit? }`, taken from the
  live engine's own `metadata` at the time of the call.
- `TrajectoryRecord.wrapperVersion` — `WRAPPER_VERSION` from
  `src/version.ts`, kept in sync with `package.json#version`.
- `EpisodeMetadata.engine` — the same engine metadata, recorded once at
  episode creation.

Evaluation reports additionally record the exact Node version/platform,
scenario fingerprint, declared/evaluated seeds, stable run order,
initial-snapshot hashes, and policy-adapter metadata. A source attestation
records source-file hashes and working-tree state when evidence-grade
provenance is needed.

A reproduction attempt should treat a hash mismatch across two runs whose
recorded engine commit, wrapper source/version, runtime, seed, or initial
conditions differ as **inconclusive, not a bug** — the runs weren't
reproducing the same thing to begin with. A hash mismatch between two runs
with matching provenance, initial conditions, seed, and normalized action
sequence is a determinism regression worth investigating.

## Reproducing an episode from its manifest and trajectory log

Every episode's trajectory is an append-only JSONL file at
`.data/episodes/<episodeId>/trajectory.jsonl` (see
[README.md](../README.md#data-storage-and-cleanup)), one `TrajectoryRecord`
per `create_episode` / `mutation` / `rollback` / `end_episode` step, each
carrying: `sequence`, `revision`, `toolName`, `args`, `preStateHash`,
`postStateHash`, `normalizedAction`, `events`, `invariantResults`, `engine`,
`wrapperVersion`, and `latencyMs` (timing only — never part of any
determinism check). The `attempts.jsonl` log additionally records
agent/evaluator attempts, outcomes, revisions, idempotency keys, and input
hashes. A rejected engine mutation that required (or confirmed)
rollback is also recorded as a `step: "rollback"` node. Its
`rollback.restoredStateHash` must equal both the node's `postStateHash` and the
next accepted mutation's `preStateHash`; rollback nodes are audit records and
are excluded from agent step and tool-efficiency counts.

To reproduce an episode:

1. **Match the environment.** Confirm the reproduction machine has the same
   Node/runtime and wrapper source, and a checkout of the exact engine commit
   recorded in the trajectory's `engine.commit` field — run
   `BBGM_SOURCE_DIR=/absolute/path/to/zengm pnpm engine:verify` against it.
   For evidence-grade work, compare the retained source attestation and the
   report/replay provenance rather than relying on a version string alone.
2. **Re-create the episode** with the same `scenarioId`, `seed`, and
   `userTeamId` from the original scenario manifest or the `create_episode`
   trajectory record's `args`. If the scenario uses `initialSnapshotPath`,
   provide the exact snapshot bytes and verify the relevant recorded hash. The
   report/runner hash is SHA-256 over the snapshot file bytes, while episode
   metadata/trajectory `initialSnapshotHash` is the canonical JSON state hash
   of the parsed snapshot. The trajectory intentionally stores no raw
   snapshot. This should reproduce the first record's `postStateHash`.
3. **Replay the same tool calls, in the same order, with the same
   normalized actions**, reading each accepted trajectory record's
   `toolName` and `normalizedAction` (not the raw MCP `args`, which may
   include incidental fields like a caller-chosen `idempotencyKey` that
   don't affect engine behavior — `normalizedAction` is the
   engine-semantics-relevant part, e.g. `{ type: "release_player", pid }`).
   A rollback node is not replayed as a second engine action; it is checked as
   evidence that the preceding rejected attempt restored the recorded state
   hash. Use `expectedRevision` values that match the accepted record's
   revision sequence, not values from a diverged run.
4. **Compare `stateHash` at each step**, not just at the end. Comparing
   only the final hash conflates "diverged on step 3 but ended up in the
   same place" with true reproduction, and — more importantly — hides
   _where_ a divergence started, which is exactly the information you need
   to tell a genuine non-determinism bug apart from a replay mistake (wrong
   action order, stale revision, or a version mismatch per the section
   above).

For a clean-room verification of a canonical grant artifact, first run the
artifact-consistency verifier, then run the repository replay tool from a
checkout with the separately obtained engine:

```sh
pnpm research:verify \
  --report .data/grant-ready-final-v9/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-ready-final-v9
```

```sh
BBGM_SOURCE_DIR=/absolute/path/to/your/pinned/zengm \
pnpm research:replay \
  --report .data/grant-ready-final-v9/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-ready-final-v9 \
  --out .data/grant-ready-final-v9/replay-manifest.json
```

`research:verify` checks report/episode structure and internal consistency but
does not execute the engine. `research:replay` re-executes each recorded
normalized action against a fresh worker-backed engine, compares the state hash
at every create, mutation, rollback, checkpoint, and end boundary, and writes
a `grant-replay.v1` provenance record containing selected artifact checksums,
engine identity, runtime/package versions, and working-tree state. Replay
fails closed when checkpoint/restore IDs cannot be linked to importable replay
snapshots. It also currently fails closed for episodes whose create record
carries `initialSnapshotHash`; the replay command cannot yet reconstruct an
initial-snapshot episode from the report/data root alone. Do not claim
clean-room replay for such an episode until the snapshot is handled by the
replay workflow.

For source provenance, run `pnpm research:attest` separately. Its
`source-attestation.v1` output hashes the selected source tree and records git
status/diff, runtime/package versions, and the pinned engine identity; it is a
provenance record, not a signed external attestation.

Because checkpoints (`bbgm_create_checkpoint`) capture a full importable
engine snapshot at a given revision, including the real worker's
`xorshift32-v1` RNG state, they can also be used to resume reproduction from
partway through an episode rather than always replaying from
`create_episode` — restore the checkpoint, then continue replaying from the
trajectory record immediately after it.
