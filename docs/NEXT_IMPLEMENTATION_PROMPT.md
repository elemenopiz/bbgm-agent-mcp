# Next implementation prompt

Use this as the single-pass handoff prompt for the next engineering pass.

## Mission

Continue development of this repository as a standalone TypeScript Model
Context Protocol (MCP) server connecting an LLM agent to a headless Basketball
GM simulation engine. The governing research objective is a credible
Thinking Machines Lab Safety Research Grant application using Tinker credits
to study **reward hacking, oversight-sensitive behavior, and safety-relevant
behavioral change after narrow fine-tuning in stateful tool environments**.
The benchmark must compare a base open-weight model with a proxy-fine-tuned
version using a hidden intended objective, held-out conditions, and exact
failure evidence. Basketball GM is the instrument, not the safety claim.

Optimize for safety construct validity, objective separation, determinism,
reproducibility, observability, honest failure reporting, and grant-quality
evidence. Do not declare a model safe, aligned, deceptive, or competent based
on a short fake-engine demo or a single reward number.

## Starting context

- Read `docs/PROJECT_GOAL.md` first; it is the durable definition of done.
- Read `docs/ARCHITECTURE.md`, `docs/TOOL_CATALOG.md`,
  `docs/RESEARCH_PROTOCOL.md`, `docs/ENGINE_INTEGRATION.md`, and
  `docs/REPRODUCIBILITY.md` before changing contracts.
- The source is a TypeScript ESM project on Node 24/pnpm 11.
- The current official MCP specification is `2026-07-28`; the installed
  `@modelcontextprotocol/*` v2 SDK line targets that specification. Keep the
  local stdio path as the primary research transport and verify any transport
  work against the current specification rather than an older session model.
- The real engine is a separately obtained, pinned Basketball GM/zengm
  checkout. It must not be vendored or redistributed. Verify it with
  `pnpm engine:verify`, build the bridge with `pnpm engine:build`, and run
  `pnpm engine:smoke` when the checkout is available.
- `DomainService` is the transport-independent semantic boundary. MCP tools
  and the offline evaluator must both call it so behavior cannot drift.
- Each episode must remain isolated in its own engine worker, with serialized
  per-episode operations, deterministic seeding, durable metadata/snapshots,
  and a documented recovery path.

## Required implementation outcome

Deliver one coherent, reviewable implementation, not a collection of partial
stubs. Preserve the existing public contracts where possible; if a contract
must change, update schemas, tool registrations, tests, and docs together.

### MCP/protocol

1. Expose a clean MCP tool catalog with precise Zod input and output schemas,
   stable names/titles/descriptions, and truthful read-only/destructive/
   idempotent/open-world annotations.
2. Ensure every successful tool result conforms at runtime to its declared
   `outputSchema`, and every failure is an MCP tool error with a stable,
   non-sensitive error code and retryability flag. Never leak stack traces,
   local paths, raw engine objects, or internal secrets.
3. Keep stdio stdout strictly reserved for MCP framing; diagnostics belong on
   stderr. If adding HTTP, use the official `2026-07-28` Streamable HTTP
   transport, implement its current request/header requirements, validate
   `Origin`, authenticate clients, and document the deployment boundary. Do
   not add a remote transport just for feature count.
4. Preserve the separated checkpoint surface: create is non-destructive
   lifecycle, list is read-only, and restore is a revision-bearing mutation
   with its own annotation and schema.

### Domain and engine safety

1. Validate every input before the engine call, enforce phase legality, and
   represent all supported GM actions explicitly.
2. Serialize all operations per episode; use optimistic revisions and durable,
   action-bound idempotency keys. A reused key with a different payload must
   fail deterministically.
3. Snapshot before mutation, evaluate built-in and scenario hard constraints,
   roll back on hard failure, and make rollback failure quarantine the episode
   rather than pretending state is safe.
4. Add real worker deadlines, crash/exit detection, bounded resources,
   cleanup, backpressure, and a clear quarantine/resume path. Do not leave
   unresolved calls or timers behind after success, timeout, exit, or close.
5. Persist episode metadata, engine identity, current snapshot, checkpoints,
   final snapshot, idempotency history, trajectory, and every attempt. Resume
   must verify the pinned engine identity and state hash before reactivation.
6. Fail closed for unsupported engine phases, league configurations, rules,
   constraints, objectives, and fidelity compromises. Never report an
   unenforced hard rule as satisfied.

### Research harness

1. Enforce scenario information channels, permitted actions, action budgets,
   horizon, initial conditions, and hard constraints at runtime.
2. Preserve raw per-step trajectories and append-only attempt telemetry for
   accepted, rejected, stale, timed-out, retried, and idempotently replayed
   calls. Make metric denominators explicit and reproducible.
3. Emit raw metric components plus a configurable scalar reward, and support
   persisted lexicographic and Pareto comparisons. Reward weights/mode must be
   scenario data or an explicitly named configuration, never an unexplained
   CLI constant.
4. Support the required baseline set: no-op/advance-only, deterministic
   heuristic, comparable Basketball GM built-in AI where available, and
   adapter hooks for untrained/prompted/fine-tuned/frontier open-model runs.
5. Support multi-seed evaluation, replay/state-hash verification, identical
   scenario manifests across agents, and a machine-readable report suitable
   for grant analysis. Keep evaluator-only terminal reads separate from agent
   information so restricted scenarios do not leak.

### Verification and documentation

1. Add focused unit, contract, integration, adverse-path, determinism, and
   real-engine tests. Real-engine tests may be gated when the licensed
   checkout is unavailable, but CI must say “skipped,” not imply “passed.”
2. Verify clean install, format, lint, typecheck, build, MCP stdio framing,
   schema conformance, restart/resume, timeout/quarantine, rollback, and
   concurrent episode isolation.
3. Update README and docs for the actual tool count/contracts, scenario
   schema, engine pin/license boundary, reproducibility procedure, threats to
   validity, unsupported capabilities, and release/deployment procedure.
4. Record exact commands and results. Distinguish verified behavior from
   assumptions and from known gaps.

## Acceptance gate

Run, as applicable:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:contract
pnpm test:determinism
BBGM_SOURCE_DIR=/absolute/path/to/pinned/zengm pnpm engine:verify
BBGM_SOURCE_DIR=/absolute/path/to/pinned/zengm pnpm engine:build
BBGM_SOURCE_DIR=/absolute/path/to/pinned/zengm pnpm engine:smoke
```

Before finishing, inspect `git diff`, `git diff --check`, and `git status`.
Do not include generated build/cache artifacts or unrelated user changes.
End with a candid readiness verdict: production-ready, research-preview, or
blocked, with the exact remaining blockers and the evidence supporting it.
