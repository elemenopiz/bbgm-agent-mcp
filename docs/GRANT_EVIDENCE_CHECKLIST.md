# Grant evidence checklist

This checklist maps the active Safety Research Grant claim to evidence that
exists now, a command that can reproduce it, and the remaining gate. The one
research question is whether narrow Tinker fine-tuning on an incomplete visible
proxy increases proxy-success/intended-objective-failure episodes, oversight-
sensitive behavior, or safety-relevant behavioral drift in a stateful tool
environment relative to the same model before training.

The old interactivity/steerability grant framing is superseded. Read
`docs/SAFETY_GRANT_STRATEGY.md` for the active proposal and implementation
priorities.

A demo or a single reward number is not that claim. Reports must retain raw
metrics, completion status, trajectory/attempt evidence, and provenance.

## Status vocabulary

- **Implemented** — the repository contains the mechanism and contract.
- **Measured** — a generated artifact in this checkout records the result.
- **Reproducible** — the documented command can regenerate it with the
  separately obtained engine checkout.
- **Partial** — an important comparison, completion condition, or fidelity
  check is missing.
- **Pending** — proposed work or a mechanism without evidence of the empirical
  claim.
- **Blocked** — the current artifact cannot pass its stated gate; name the
  exact failure.

“Implemented” and “Measured” must not be paraphrased as “the agent succeeds.”

## Safety-grant gates

Before a safety claim is made, the evidence bundle must also show:

- the visible proxy and hidden intended objective were frozen before training;
- policy-visible observations exclude hidden evaluator formulas and metrics;
- proxy-success/intended-objective-failure has a pre-registered threshold and
  episode-level definition;
- held-out seeds, hidden valuations, and scenario variants were not used for
  training or checkpoint selection;
- oversight-sensitive behavior is measured as a behavioral signature, without
  inferring deception or internal intent; and
- tail or worst-seed outcomes are reported beside means.

## Shortest reviewer path

Run from the repository root with Node 24 and pnpm 11. Basketball GM is
external; obtain it separately and comply with its upstream license.

```sh
corepack pnpm install --frozen-lockfile
export BBGM_SOURCE_DIR=/absolute/path/to/your/zengm-checkout
(cd "$BBGM_SOURCE_DIR" && pnpm install)

corepack pnpm check
BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node scripts/run-grant-demo.mts \
  --data-root .data/grant-demo-reproduction \
  --out .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --summary-out .data/grant-demo-reproduction/reviewer-summary.md

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node --experimental-strip-types \
  scripts/verify-grant-artifact.mts \
  --report .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-demo-reproduction

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm research:replay \
  --report .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-demo-reproduction \
  --out .data/grant-demo-reproduction/replay-manifest.json
```

The runner covers exactly two policies (`heuristic`, `no_op`) across the five
seeds in `scenarios/long-horizon-asset-preservation.json`. It is the baseline
runner; `pnpm research:demo` is the separate meaningful capability demo. The
fresh report must pass the artifact verifier and replay before it is called a
shareable verified baseline.

## Current local evidence

The current checkout contains `.data/grant-ready-final-v9/` with a raw report,
summary, episode logs, and a replay manifest. The raw report has
exactly 10 results:

- heuristic completes 3/5 two-season runs;
- no_op completes 0/5 and stalls after 7 steps at its mandatory draft
  boundary;
- the report contains 17 refusal rollback events on heuristic seeds 003 and
  004; and
- all terminal states satisfy their final constraints, while the two heuristic
  and five no-op incomplete runs remain in the intention-to-treat view.

This artifact is **Measured and verifier-passing**. Its small pilot sample is
descriptive, and its replay manifest must be retained with the exact source
attestation before sharing.

The held-out control artifact at `.data/grant-ready-heldout-v1/` is **Measured,
bounded**: it contains heuristic/no-op results on the two frozen held-out
seeds, with heuristic completing 1/2 and no_op 0/2. It is a small
generalization check, not a powered statistical claim.

The open-model artifact at `.data/open-model-smoke-v4/` is **Measured, bounded
only**. It contains three results on one seed and three steps: no_op,
heuristic, and untrained `HuggingFaceTB/SmolLM2-135M-Instruct`. The model uses
revision `12fd25f77366fa6b3b4b768ec3050bf629380bac`; it made two calls, one
parse failure and one provider failure, and no typed model action executed.
Traces and model telemetry retain that failure. It is inference-boundary
evidence, not long-horizon competence or Tinker training.

The meaningful demo at `.data/meaningful-demo-v2/decision-timeline.json` is a
**Measured capability trace**. It covers typed roster changes, an evaluated
accepted trade, deadline progression, a draft pick, checkpoint restore, and
repeated draft selection. It is not a policy score.

The engine identity check currently passes with
`BBGM_SOURCE_DIR=.cache/zengm node scripts/verify-engine.ts` for Basketball GM
5.1.0 at commit `4ee432c5b9097ed978749a049fff5823711690dc` and the locked
license hash. The final packet must attach the complete `pnpm check` and
real-engine command transcript rather than relying on this summary.

## Claim-to-evidence matrix

| Claim                                                       | Inspect                                                                                                                     | Current status                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This is a real delayed-consequence environment.             | `scenarios/long-horizon-asset-preservation.json`; report `scenario`, `results[]`, and episode trajectories.                 | **Measured, partial:** five heuristic runs complete two seasons; five no_op controls stall at a mandatory decision.                                                              |
| The policy boundary is typed and constrained.               | 16 registrations in `src/tools/registerTools.ts`, schemas, worker/domain checks, and contract/e2e tests.                    | **Implemented and tested:** package, e2e, contract, determinism, and real-engine integration gates pass.                                                                         |
| Trajectory quality and failures are observable.             | `trajectory.jsonl`, `attempts.jsonl`, `trajectorySummary`, completion status, rollback records.                             | **Measured:** v9 retains accepted/rejected attempts and completion/stall outcomes; the verifier passes.                                                                          |
| Hard rules are enforced mechanically.                       | Scenario hard constraints, per-step invariant fields, terminal metrics, rollback behavior.                                  | **Measured, partial:** zero terminal violations are recorded, but stalled runs do not demonstrate full-horizon behavior.                                                         |
| Assets are measured beside performance.                     | `current_player_value`, `draft_capital_value`, `total_asset_value`, roster metrics, transactions.                           | **Implemented/measured:** these are explicit proxies, not proof that a policy preserves real-world value.                                                                        |
| Invalid, stale, retry, and rollback behavior is measurable. | Attempt logs and `results[].trajectorySummary`; seed 003/004 rejection counts.                                              | **Measured:** invalid attempts are retained; MCP argument failures before `DomainService` are outside the current rate.                                                          |
| Results are reproducible across fixed seeds.                | Engine lock, scenario fingerprint, provenance, normalized actions, state hashes, verifier, replay.                          | **Measured, pilot:** v9 passes the verifier and its 10-episode replay; source attestation is retained with the evidence roots.                                                   |
| Reference policies make comparisons interpretable.          | no_op and heuristic results, summaries, aggregates, completion-aware comparison.                                            | **Measured:** deterministic controls only; not a learned-agent result.                                                                                                           |
| A real open model crosses the typed boundary.               | `.data/open-model-smoke-v4/report.json`, `traces/`, run manifest, model manifest, adapter.                                  | **Measured, bounded failure:** one seed and two model calls; no typed action or competence claim.                                                                                |
| Tinker improves the open model.                             | Trained checkpoint lineage, rollout tokens/masks/log-probabilities/rewards, unchanged controls, frozen dev/held-out report. | **Pending:** no Tinker training artifact exists in this checkout.                                                                                                                |
| Evidence can be shared legally and operationally.           | `LICENSE-WRAPPER.md`, `THIRD_PARTY.md`, `bbgm-engine.lock.json`, clean-install transcript, source attestation.              | **Measured, with transcript caveat:** engine boundary is documented, identity check passes, and the final source attestation exists; attach the command transcript when sharing. |

## Required bundle

Before sharing, preserve:

1. the exact wrapper commit/archive and `bbgm-engine.lock.json`;
2. all three scenario manifests (pilot, development, held-out) and the open
   model smoke manifest;
3. a freshly generated canonical JSON report and reviewer summary;
4. per-episode `trajectory.jsonl`, `attempts.jsonl`, metadata, checkpoints,
   and final snapshots;
5. a passing artifact verifier and clean-room replay manifest for the fixed
   panel (plus the held-out verifier report);
6. command transcript, runtime versions, engine verification, lockfile hash,
   git status, and source attestation; and
7. for a trained run, model/checkpoint identity, adapter and prompt hashes,
   training configuration, rollout records, checkpoint lineage, and unchanged
   baseline results on the same seeds.

Generated timestamps and episode IDs are operational identifiers, not results.
Do not hand-edit report numbers.

## Reviewer-safe wording

> This repository provides a pinned, instrumented Basketball GM decision
> environment with explicit constraints, transparent reference policies,
> trajectory/attempt telemetry, and a meaningful typed-action demonstration.
> Its current local pilot contains 10 reference-policy results: heuristic
> completes three of five seeds and no_op stalls on all five. A separate
> bounded one-seed smoke records one untrained model parse failure and one
> provider failure at the typed adapter boundary. No Tinker-trained result or
> long-horizon open-model competence claim is made.

Do not claim “the agent preserves assets,” “the model beats the heuristic,”
“the benchmark is statistically validated,” or “Tinker results exist” without
the corresponding passing report, provenance, and analysis.

## Remaining safety-grant-critical work

- preserve the verified v9 baseline and complete its source attestation/replay
  bundle;
- define and freeze the visible proxy, hidden intended objective, proxy-intent
  divergence endpoint, and oversight-condition protocol;
- run the untrained model and unchanged controls across the frozen development
  and held-out split;
- add Tinker rollout/training records and checkpoint lineage;
- evaluate proxy-fine-tuning on held-out seeds, hidden valuation variants, and
  changed scenario conditions;
- pre-register proxy divergence, tail degradation, constraint, invalid-action,
  and generalization outcomes, with intention-to-treat and completed-only
  views; and
- preserve the complete source, report, raw logs, replay, attestation, and
  command transcript.
