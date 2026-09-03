# Grant demo runbook

This runbook separates three reproducible outputs:

1. the canonical five-seed reference-policy pilot;
2. the one-seed, three-step untrained open-model adapter smoke; and
3. the short meaningful capability demonstration.

These outputs establish environment, baseline, and inference boundaries. None
is a Tinker training result or evidence that an open model is competent.

## Prerequisites

Use Node 24 and pnpm 11, install wrapper dependencies from the frozen lockfile,
and obtain the Basketball GM/zengm checkout separately at the exact identity in
`bbgm-engine.lock.json`:

- version `5.1.0`;
- commit `4ee432c5b9097ed978749a049fff5823711690dc`; and
- license SHA-256
  `4b062aff490de1273782c6ab56839be01913690f494f0c95ac02bb07cb1f3603`.

The engine is not downloaded, bundled, or redistributed by this repository.
Install its dependencies in its own checkout and comply with its license.

## Canonical reference-policy pilot

Run from the wrapper repository root:

```sh
nvm use
corepack enable
corepack pnpm install --frozen-lockfile

export BBGM_SOURCE_DIR=/absolute/path/to/your/zengm-checkout
(cd "$BBGM_SOURCE_DIR" && pnpm install)

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node scripts/run-grant-demo.mts \
  --data-root .data/grant-demo-reproduction \
  --out .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --summary-out .data/grant-demo-reproduction/reviewer-summary.md
```

The runner executes `engine:verify`, `engine:build`, and the evaluator on
`scenarios/long-horizon-asset-preservation.json` with policies `heuristic` and
`no_op`. It then checks report shape, verifies episode audit data, and writes a
reviewer summary. The expected fresh report has exactly 10 results: one result
for each policy and each of the five declared seeds.

Do not use `pnpm research:demo` for this step. That package script invokes the
separate meaningful capability demo described below.

Verify and replay the fresh report:

```sh
BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node --experimental-strip-types \
  scripts/verify-grant-artifact.mts \
  --report .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-demo-reproduction

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm research:replay \
  --report .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-demo-reproduction \
  --out .data/grant-demo-reproduction/replay-manifest.json
```

The verifier checks trajectory and attempt counters, state hashes, terminal
metrics, and rollback records. Replay re-executes normalized actions against
fresh workers and compares state hashes at create, mutation, rollback, and end
boundaries. Treat a failed verifier or replay as a failed evidence gate.

### Current local pilot

The current verified pilot is at `.data/grant-ready-final-v9/`:

- raw report:
  `.data/grant-ready-final-v9/long-horizon-asset-preservation-v1.json`;
- summary: `.data/grant-ready-final-v9/reviewer-summary.md`; and
- replay manifest: `.data/grant-ready-final-v9/replay-manifest.json`.

It contains 10 reference-policy results. Heuristic completes 3/5 seeds; no_op
completes 0/5 and stalls after 7 steps at its intentional mandatory-draft
boundary. The pilot records 17 refusal rollback events on heuristic seeds 003
and 004. The report passes the artifact verifier; the replay manifest
independently re-executes its actions and matches all 17 rollback records. All
terminal hard-constraint violation counts are zero; rejected free-agent
attempts remain visible as invalid-action evidence.
The two heuristic stalls and all no-op stalls remain in the report and must not
be silently dropped from interpretation.

## Reading the reference report

Inspect these fields before interpreting any score:

- `scenario`: manifest, seed set, allowed information/actions, horizon, budget,
  constraints, and reward mode;
- `provenance`: wrapper, runtime, engine, scenario fingerprint, and policy
  identities;
- `results[].completionStatus`: `completed`, `budget_exhausted`, or `stalled`;
- `results[].metricComponents`: raw win, asset, constraint, action, and
  efficiency metrics; and
- `results[].trajectorySummary` plus the matching episode logs under
  `episodes/<episodeId>/`.

Incomplete runs stay in the primary intention-to-treat view. Completed-only
summaries must be labeled as such. The pilot's descriptive intervals and
effect sizes do not establish statistical validation with five seeds.

## Open-model inference smoke

The concrete adapter is
`experiments/open-model/tinker-compatible-adapter.mts`. It calls either a
Tinker OpenAI-compatible sampler or the local server described in
`experiments/open-model/README.md`, validates one typed action per turn, and
writes raw model traces.

Follow that README for the pinned local model setup. The current smoke artifact
is `.data/open-model-smoke-v4/`: it contains three one-seed, three-step results
(heuristic, no_op, and `untrained_open_model`). The pinned SmolLM2 model made
two calls: one parse failure and one provider failure; no typed model action was
successfully executed. Its model revision, prompt hash, endpoint, decoding
settings, telemetry, and raw responses are recorded. This is a real
failed-inference/parser measurement, not long-horizon competence, a trained
checkpoint, or a Tinker result.

For a fresh local smoke, the executable command is the one in
`experiments/open-model/README.md`; keep its output in a new `.data/` directory
and record the model revision and prompt identity.

## Held-out reference panel

The held-out controls are evaluated separately with the frozen manifest:

```sh
BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" BBGM_ENGINE_TIMEOUT_MS=180000 \
BBGM_EVAL_PARALLELISM=1 corepack pnpm exec tsx src/research/evaluate.ts \
  --scenario scenarios/long-horizon-asset-preservation-heldout.json \
  --policy all \
  --data-root .data/grant-heldout-reproduction \
  --out .data/grant-heldout-reproduction/heldout-report.json

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm research:verify \
  --report .data/grant-heldout-reproduction/heldout-report.json \
  --data-root .data/grant-heldout-reproduction
```

The current held-out artifact is
`.data/grant-ready-heldout-v1/heldout-report.json`: heuristic completes 1/2
seeds and no_op completes 0/2. It is a small generalization check and not a
statistically powered result.

## Meaningful capability demonstration

Run the separate deterministic walkthrough:

```sh
BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm research:demo
BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm research:verify-demo
```

It writes `.data/meaningful-demo-v2/decision-timeline.json` and exercises typed
roster changes, an evaluated and accepted trade, regular-season deadline
progression, a draft pick, checkpoint restore, and the same draft pick again.
It records state hashes, revisions, phases, transaction counts, and terminal
constraint status. It is a capability trace, not a performance result.

## Source attestation

After collecting the desired outputs and final source/docs edits, create the
attestation:

```sh
corepack pnpm research:attest \
  --artifact-root .data/grant-ready-final-v9 \
  --artifact-root .data/grant-ready-heldout-v1 \
  --artifact-root .data/open-model-smoke-v4 \
  --artifact-root .data/meaningful-demo-v2
```

The attestation records source hashes, runtime and engine identity, git status,
lockfile identity, and artifact roots. Because generated data are ignored by
Git, the attestation and exact checkout/diff must travel with the bundle.

## Reviewer-safe claim

> This repository provides a pinned, instrumented Basketball GM decision
> environment with transparent reference policies, explicit constraints,
> trajectory/attempt telemetry, and a meaningful typed-action demonstration.
> The current local pilot has 10 reference-policy results: heuristic completes
> three of five seeds and no_op stalls on all five; a separate two-seed held-out
> control panel verifies the split machinery. A one-seed smoke records a real
> open-model parse/provider failure through the typed adapter. No Tinker-trained
> result or long-horizon open-model competence claim is made; the proposed grant
> work will add rollout/training records and run the frozen development/held-out
> pre/post comparison.
