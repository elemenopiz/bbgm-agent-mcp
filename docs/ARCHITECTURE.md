# Architecture

This document describes the layers `bbgm-agent-mcp` is built from, how a
single tool call flows through them, and why episodes are isolated the way
they are. It complements [docs/ENGINE_INTEGRATION.md](ENGINE_INTEGRATION.md)
(the low-level detail of the real-engine bridge) and
[docs/TOOL_CATALOG.md](TOOL_CATALOG.md) (the tool-by-tool reference).

## The seven layers

```
┌─────────────────────────────────────────────────────────────────┐
│ 6. Research / evaluation layer (src/research/)                  │
│    Calls DomainService directly. Bypasses MCP entirely.         │
└───────────────────────────────┬─────────────────────────────────┘
                                 │
┌───────────────────────────────▼─────────────────────────────────┐
│ 5. MCP tool registrations (src/tools/, src/server/)              │
│    One thin registerX() per bbgm_* tool: Zod schema + annotations│
│    + a call into DomainService. No business logic lives here.    │
└───────────────────────────────┬─────────────────────────────────┘
                                 │
┌───────────────────────────────▼─────────────────────────────────┐
│ 4. DomainService (src/domain/DomainService.ts)                   │
│    Legality/phase checks, revision + durable idempotency          │
│    bookkeeping, invariant evaluation, rollback-on-failure,        │
│    trajectory and attempt logging.                                │
│    The one place both layer 5 and layer 6 funnel through, so     │
│    an LLM agent and a scripted evaluation run see identical      │
│    semantics.                                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                 │
┌───────────────────────────────▼─────────────────────────────────┐
│ 3. Episode / session manager (src/sessions/)                     │
│    EpisodeManager + EpisodeStore: owns episode lifecycle, durable │
│    metadata/resume, one engine instance per episode, and the      │
│    per-episode serialized command queue. No business rules live   │
│    here either.                                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                 │
┌───────────────────────────────▼─────────────────────────────────┐
│ 2. SimulationEngine implementations                              │
│    ┌────────────────────────────┐  ┌───────────────────────────┐│
│    │ 1. SimulationEngine         │  │ 7. FakeSimulationEngine    ││
│    │    interface (src/domain/)  │  │    (tests/fixtures/)       ││
│    │    transport-independent    │  │    in-process, deterministic│
│    │    contract every engine    │  │    fake used ONLY by unit  ││
│    │    implements               │  │    tests -- never in prod  ││
│    └──────────────┬───────────────┘  └───────────────────────────┘│
│                   │ implemented by                                │
│    ┌──────────────▼───────────────────────────────────────────┐  │
│    │ BasketballGmEngine (src/engine/bbgm/)                     │  │
│    │ Real engine. Talks over postMessage to an isolated        │  │
│    │ node:worker_threads Worker running engine-bridge/entry.ts,│  │
│    │ which loads the headless Basketball GM bundle built by    │  │
│    │ `pnpm engine:build` against a user-supplied BBGM_SOURCE_DIR│  │
│    └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

Layers 1, 2, and 7 together are what the brief calls "the
transport-independent `SimulationEngine` interface, its real worker-thread
implementation, and the in-process fake used only for unit tests" — they're
grouped in one box above because they're the same contract with three
participants (the interface, and its two implementations), not three
separate pipeline stages.

Two invariants hold across all seven layers:

- **Nothing above layer 4 knows about MCP, and nothing at or below layer 4
  knows about MCP either.** `DomainService` and everything it depends on is
  plain TypeScript with no `@modelcontextprotocol` import. Only layer 5
  imports MCP server types. This is what makes layer 6 possible: the
  research/evaluation harness gets the exact same legality checks,
  concurrency guarantees, and trajectory logging as a live agent session,
  by calling `DomainService` directly instead of going through a
  simulated MCP client.
- **Nothing in `SimulationEngine` or its implementations knows about
  revisions, idempotency, or invariants.** Those are `DomainService`'s job.
  An engine only ever answers "what is the state" and "apply this action";
  it has no concept of a stale revision or a rolled-back mutation.

## Request / mutation state flow

The path a single mutating tool call takes, end to end (read-only calls
skip the phases marked with `†`):

```mermaid
sequenceDiagram
    participant Agent as MCP client (agent)
    participant Tool as tools/*.ts (layer 5)
    participant Domain as DomainService (layer 4)
    participant Episode as EpisodeManager/EpisodeStore (layer 3)
    participant Engine as SimulationEngine (worker thread)
    participant Traj as TrajectoryWriter (persistence)
    participant Audit as AttemptWriter (persistence)

    Agent->>Tool: bbgm_execute_trade(input)
    Tool->>Tool: Zod inputSchema.parse (reject on VALIDATION_ERROR)
    Tool->>Domain: domain.executeTrade(episodeId, proposal, {expectedRevision, idempotencyKey})
    Domain->>Domain: idempotency cache check (return cached result if key seen)
    Domain->>Episode: enqueue on episode's serialized queue †
    Note over Domain,Episode: only one in-flight mutation per episode at a time
    Domain->>Domain: revision !== expectedRevision? -> REVISION_CONFLICT †
    Domain->>Engine: getRawState() (pre-mutation)
    Domain->>Domain: phase checks (requiredPhase / disallowedPhases) -> INVALID_PHASE †
    Domain->>Domain: legality(state) -> ILLEGAL_ACTION †
    Domain->>Engine: exportSnapshot() (rollback point) †
    Domain->>Engine: execute(record) -- the actual mutation call
    Engine-->>Domain: EngineEvent[]
    Domain->>Engine: getRawState() (post-mutation)
    Domain->>Domain: evaluate built-in + scenario invariants
    alt hard invariant failed
        Domain->>Engine: importSnapshot(rollbackSnapshot)
        Domain-->>Tool: throw INVARIANT_VIOLATION
    else invariants satisfied
        Domain->>Domain: revision += 1; compute stateHash
        Domain->>Traj: append trajectory record (pre/post hash, action, events, invariants)
        Domain->>Audit: append accepted attempt with revision/key/outcome
        Domain-->>Tool: MutationResult
    end
    Tool-->>Agent: {content, structuredContent} or {content, isError: true}
```

In prose, the fixed pipeline every mutation goes through is: **tool call
→ Zod validation → `DomainService` → legality/phase checks → the episode's
serialized command queue → the engine call inside its worker thread →
post-mutation invariant checks → rollback-on-failure if a hard invariant
failed → revision increment → trajectory append → normalized response.**
Read-only tools (`bbgm_get_state`, `bbgm_get_options`,
`bbgm_evaluate_trade`, and `bbgm_list_checkpoints`) take the same
path minus the expectedRevision check, the snapshot/rollback machinery, and
the revision increment — they still run on the same per-episode queue as
mutations, so a read is never interleaved mid-mutation.

## Episode isolation model

Each episode gets its own `SimulationEngine` instance — in production, its
own dedicated `node:worker_threads` `Worker`. Three design decisions follow
directly from that:

**Why a worker thread per episode, not one shared engine process.** The
real Basketball GM engine was built as a single-page web app: it relies on
module-level singletons and an IndexedDB-backed database (`fake-indexeddb`
in the headless bridge) that were never designed to host more than one
league per JS realm. Rather than fight that assumption, each episode gets a
fresh `Worker`, i.e. a fresh V8 isolate with its own module graph and
globals. This means one episode's engine state can never leak into
another's, and — just as important for a long-running MCP server — a hard
crash, an unbounded loop, or a memory leak inside one episode's engine
terminates only that worker. Other active episodes, and the MCP server
process itself, are unaffected; `BasketballGmEngine`'s `worker.on("error",
...)` handler rejects only that episode's in-flight calls.

**Why `Math.random` must never be global.** The headless bridge
(`engine-bridge/entry.ts`) replaces `Math.random` with a seeded PRNG
(`hashSeed(seed)` feeding a small xorshift generator) so that gameplay
outcomes are a deterministic function of the episode's seed and action
sequence — a requirement for the reproducibility guarantees in
[docs/REPRODUCIBILITY.md](REPRODUCIBILITY.md). `Math.random` is a
process-wide global; overwriting it is inherently a shared-mutable-state
operation. If two episodes' engines ran in the same process, they would
fight over the same `Math.random` override, and whichever engine reseeded
it last would silently corrupt the other's determinism — an error that
would be invisible until someone tried to reproduce a trajectory and
couldn't. Running one engine per worker thread means each worker has its
own JS realm and therefore its own `Math.random`, scoped to that episode's
seed with no possibility of cross-episode interference.

**Why the command queue is serialized per episode.** Every
`SimulationEngine` method is `async`, and MCP tool calls for the same
episode can arrive back-to-back or even concurrently from a client. The
mutation pipeline above is not atomic across its own steps — it reads
state, checks legality against that read, executes, re-reads, checks
invariants, and only then commits a revision bump — so if a second call for
the same episode were allowed to start mid-pipeline, it could legality-check
against state that's about to change underneath it, corrupt the
snapshot-based rollback, or double-count a revision. `EpisodeManager` gives
each `EpisodeRecord` a `queue: Promise<void>` that every operation chains
onto (`DomainService.runQueued`), so at most one engine operation is
in-flight per episode at any time, while unrelated episodes remain fully
parallel — the queue is per-episode, not global, so isolation never becomes
a throughput bottleneck across episodes.
