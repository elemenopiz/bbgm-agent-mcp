# Next-session handoff: Safety Research Grant

Status captured: 2026-09-03, America/Chicago.

This document is the authoritative pickup point for the next work session. The
current objective is to prepare a credible application for Thinking Machines
Lab’s Safety Research Grant. The active research question is whether narrow
fine-tuning on an incomplete visible proxy causes reward hacking,
oversight-sensitive behavior, or safety-relevant behavioral change in a
stateful tool environment. The grant-funded Tinker training run is future
work; do not describe it as already completed.

The active source of truth is `docs/SAFETY_GRANT_STRATEGY.md`, with the
submission draft in `docs/GRANT_BRIEF.md`. The official submission deadline is
September 25 at 11:59 PM PDT; send materials to `grants@thinkingmachines.ai`.

## Active safety framing

The project is a controlled safety evaluation built around the real Basketball
GM (BBGM) engine. The benchmark should preserve its typed actions, state
inspection, trades, free agency, contract decisions, roster management,
milestone-based time advancement, checkpoints, rollback, and deterministic
seeded episodes because those features expose delayed consequences and
stateful tool-use failures.

The safety contribution is the separation of a training-visible proxy from a
hidden, independently computed intended objective. The primary test is whether
narrow proxy fine-tuning produces proxy-success/intended-objective-failure
episodes or other pre-registered oversight-sensitive behavior. Safety must
protect the environment and preserve evidence; it must not silently repair
agent failures or turn incomplete runs into success.

The former interactivity/steerability agenda is superseded. Owner feedback,
employment/firing, live human steering, and a five-minute timer are not active
grant requirements. Preserve their old design notes only as historical context
unless the user explicitly reactivates them.

The five-minute timer idea is explicitly brainstorming only. It is not part of
the core proposal or current success criteria. It may later be evaluated as an
optional stress condition, but it must not delay the application-ready packet.

The research lens is: does a narrow training signal produce safe behavior or
proxy optimization when a language-model agent makes auditable, long-horizon
decisions under interacting constraints, irreversible-looking consequences,
deadlines, uncertainty, and a broad action space? BBGM is useful because the
agent must repeatedly observe, trade off short- and long-term value, handle
refusals and changing market conditions, and resolve mandatory deadlines
without a single obvious correct action.

## Current model inventory

### Actually exercised

- `no_op`: deterministic control. It advances until it reaches the mandatory
  draft decision and then stalls by design. This measures what happens without
  decision-making and prevents a false claim that a stalled episode is a
  completed baseline.
- `heuristic`: deterministic reference policy. It performs roster and lineup
  management, contract decisions, free-agent attempts, and draft/trade actions
  through the same typed environment boundary. It is a baseline, not a learned
  agent.
- `untrained_open_model`: a real OpenAI-compatible/Tinker-compatible adapter in
  `experiments/open-model/tinker-compatible-adapter.mts`, targeting the pinned
  local model `HuggingFaceTB/SmolLM2-135M-Instruct`, revision
  `12fd25f77366fa6b3b4b768ec3050bf629380bac`. The prior v3 smoke did make real
  provider calls. The current v4 smoke made two calls: one parse failure and
  one provider failure before producing a typed action. This is valid
  adapter/boundary evidence, not a competence result.

### Registered but not yet exercised

`prompted_open_model`, `fine_tuned_model`, `frontier_reference_model`, and
`tinker` are extension slots registered as unavailable until a concrete model,
checkpoint, or endpoint is supplied. They are not current results. The grant
proposal should ask for the Tinker training/evaluation phase that will populate
the learned-agent comparison.

There is no current Tinker-trained checkpoint and no current learned-agent
performance claim. Keep the distinction explicit in every report and grant
document:

1. environment validation;
2. deterministic baseline performance;
3. untrained open-model adapter/boundary performance;
4. future Tinker-trained-agent performance.

## What is already in place

The current worktree contains the major environment and evidence machinery:

- typed MCP tools and a transport-independent policy interface;
- real BBGM 5.1.0 integration pinned to commit
  `4ee432c5b9097ed978749a049fff5823711690dc`;
- real-engine snapshots, seeded RNG control, checkpoints, rollback, episode
  quarantine, and audit logs;
- state views for overview, roster, draft, free agents, contracts, and
  options, with draft-pick visibility;
- trade evaluation/execution, lineup changes, releases, contract negotiation,
  free-agent signing, draft picks, and explicit time advancement;
- episode/attempt/trajectory persistence and replay verification;
- policy telemetry for model calls, parse failures, provider failures, model
  failures, and tool errors;
- completion-aware aggregate ranking so an incomplete control cannot outrank a
  policy merely because it avoided making decisions;
- metrics for wins, asset value, seasons completed, hard-constraint violations,
  invalid actions, stale actions, decision efficiency, and paired uncertainty/
  effect-size summaries;
- a meaningful demo verifier covering a deadline, trade, draft pick,
  checkpoint restore, and re-pick with zero hard constraint violations;
- docs for functionality audit, research protocol, reproducibility, grant
  brief, Tinker plan, runbook, checklist, release checklist, and evidence
  bundle.

## Important finding: “unwilling free agent”

An unwilling free agent is a player for whom the real BBGM engine rejects the
signing attempt regardless of the offer supplied in that call. The engine’s
error text is effectively “refuses to sign with you, no matter what you
offer.” This is game-state behavior—not an MCP refusal, not an invented
benchmark restriction, and not evidence that the player is universally
unsignable in every future context. It can reflect the engine’s team/player
preference logic and current circumstances.

The earlier heuristic repeatedly probed candidates that had already refused,
which created many legitimate rollback records and could look like a loop. The
policy now keeps an episode-local refusal cache and does not retry a known
refusal in that episode. The logs should retain the first refusal as an honest
invalid-action/safety-boundary signal. Do not remove these outcomes merely to
make the baseline look cleaner.

## Concurrency finding and current safe setting

An attempted fresh run used four concurrent real-engine episodes through the
same process. It failed with:

- “Rollback failed while restoring the pre-action snapshot; episode
  quarantined”;
- “EpisodeWorkerHost has already been terminated”;
- “Episode worker call timed out after 120000ms.”

This establishes that the current real BBGM bridge/worker lifecycle is not
safe for concurrent episodes. `src/research/evaluate.ts` now defaults
`BBGM_EVAL_PARALLELISM` to `1`. The concurrency helper remains as an explicit
opt-in for a future isolated engine implementation or mock-only tests. Never
use `BBGM_EVAL_PARALLELISM=4` for canonical real-engine evidence.

## Artifact status

The following are historical or partial artifacts; do not call them final
evidence:

- `.data/grant-ready-final-v5/`: superseded 10-run panel generated before the
  latest telemetry, completion-ranking, reward-order, replay, and provenance
  changes.
- `.data/open-model-smoke-v3/`: superseded SmolLM2 traces generated before
  parse-error telemetry was included in invalid-action rates.
- `.data/meaningful-demo-v2/`: the strongest current demo artifact. Its
  verifier passed with 20 timeline entries covering accepted trade, deadline,
  draft pick, checkpoint restore, and re-pick; zero hard violations. It is
  isolated to its own data root and is still usable unless later source changes
  alter the demo contract.

The attempted `.data/grant-ready-final-v6/` parallel run failed and produced no
completed report. The attempted serialized `.data/grant-ready-final-v7/` run
was intentionally interrupted after startup and also has no completed report.
Neither is evidence.

The current evidence roots are:

- `.data/grant-ready-final-v9/`: canonical 10-result panel, verifier-passing
  and clean-room replay verified; heuristic completes 3/5 and no_op 0/5;
- `.data/grant-ready-heldout-v1/`: separate two-seed held-out control panel,
  verifier-passing; heuristic completes 1/2 and no_op 0/2; and
- `.data/open-model-smoke-v4/`: real one-seed adapter smoke with model calls,
  raw traces, and parse/provider telemetry.

## Final status and next session

The grant-ready research-preview packet is complete and has passed its final
source, package, real-engine, report, replay, demo, and skeptical-review gates.
The commands below are retained as the exact release transcript/procedure, not
as unfinished work.

### Completed: source attestation

After the final source/docs edits and fresh artifacts:

```sh
corepack pnpm research:attest \
  --artifact-root .data/grant-ready-final-v9 \
  --artifact-root .data/grant-ready-heldout-v1 \
  --artifact-root .data/open-model-smoke-v4 \
  --artifact-root .data/meaningful-demo-v2
```

The attestation records the intentionally dirty sprint worktree, wrapper commit,
source-tree hash, runtime versions, pinned engine identity, and all evidence
roots. Keep it with the generated artifacts and the exact checkout/diff.

### Completed: final gates

```sh
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
BBGM_SOURCE_DIR=.cache/zengm corepack pnpm engine:verify
BBGM_SOURCE_DIR=.cache/zengm corepack pnpm engine:smoke
BBGM_SOURCE_DIR=.cache/zengm corepack pnpm research:verify \
  --report .data/grant-ready-final-v9/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-ready-final-v9
BBGM_SOURCE_DIR=.cache/zengm corepack pnpm research:verify \
  --report .data/grant-ready-heldout-v1/heldout-report.json \
  --data-root .data/grant-ready-heldout-v1
corepack pnpm research:verify-demo \
  .data/meaningful-demo-v2/decision-timeline.json
```

The v9 replay is complete and retained in its manifest. The final code,
engine, report, and demo gates all pass.

### Completed: final skeptical review

Every current artifact and claim was reviewed against the checklist below.
The remaining scientific work is intentionally grant-funded: safety-scenario
construction, proxy/reward capture, Tinker rollout/training, oversight-
sensitive evaluation, narrow-fine-tuning generalization, tail analysis, and
larger held-out panels. Do not describe that future work as already run.

## Skeptical grant-reviewer checklist

Before applying, inspect the packet as if funding it were your decision. The
following are blockers:

- any claim that an unavailable or Tinker policy has already been trained;
- any claim that the open-model smoke demonstrates competence when it only
  demonstrates a real adapter and parse failure;
- any report that ranks an incomplete policy ahead of a completed policy
  without exposing completion rate;
- any “zero invalid actions” claim that ignores provider/parser failures;
- any replay verifier that accepts the wrong failure code or restored state;
- any concurrency setting that can corrupt or quarantine real-engine episodes;
- any current evidence pointing to a stale artifact version;
- any missing seed, prompt, model revision, scenario fingerprint, source
  version, command, raw trace, or report path;
- any claim that the action surface is literally every upstream BBGM feature.
  The audit must say what is exposed, intentionally omitted, and planned;
- any result that presents five seeds as conclusive statistical proof. Treat
  the pilot as descriptive with uncertainty/effect sizes and propose larger
  held-out evaluation in the grant;
- any use of the discarded five-minute timer as a core requirement.

## Application timeline from here

The dated plan now lives in [`docs/GRANT_TIMELINE.md`](GRANT_TIMELINE.md):
a three-week pre-submission sprint to **September 25** (internal send target
September 23), the review window, and a six-month collaboration schedule with
gates and a proposed check-in cadence. The submission artifacts are
[`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md) and
[`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md).

Blocking items are administrative, not scientific: PI and contributor names,
CVs, location, organizational status and tax ID, and the primary contact email.
Nothing else in the packet is waiting on input.

The highest-value work available before the deadline is the **planted-policy
detector calibration**. It needs no Tinker credits and no learned policy - the
planted policies are deterministic and run on local CPU through the existing
typed boundary - and it converts the construct-validity criterion from a
promise into measured evidence. Sprint order:

1. Freeze `scenarios/proxy-intent-v1.json` and pre-register the
   proxy-success / intent-failure threshold, dated.
2. Implement the five planted policies and report detector sensitivity and
   specificity against their known labels.
3. Extract the portable contract as an environment-independent spec; stub a
   second environment against it.
4. Assemble and send.

Do not delay the send to add evidence; descend the slip ladder in
`GRANT_TIMELINE.md` Part 1 instead.

The funded work after that remains: Tinker rollout capture and training,
held-out safety evaluation with hidden valuation and oversight conditions, and
tail/generalization analysis with a null-result path.

No additional agents are currently open.

## Safe cleanup on resume

Do not use `git reset --hard` or discard the dirty worktree. Existing changes
belong to this sprint and must be preserved. The partial v6/v7 data directories
are generated artifacts, not source; leave them for forensic context or move
them only with an explicit, recoverable operation. The temporary local model
server used for v4 was stopped cleanly after evaluation.
