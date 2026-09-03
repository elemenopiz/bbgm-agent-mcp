# Tinker experiment plan

> **Active framing note (2026-09-03):** This is the technical Tinker execution
> plan. Its scientific framing is now governed by
> [`docs/SAFETY_GRANT_STRATEGY.md`](SAFETY_GRANT_STRATEGY.md): reward hacking,
> oversight-sensitive behavior, and safety-relevant drift after narrow
> fine-tuning. The former interactivity/steerability framing below is
> superseded and should not be used in the application.

## Status and purpose

This is the proposed research plan for the next sprint. It is intentionally
separate from the current verified environment pilot: no Tinker training run
or learned-policy result is claimed yet. A concrete OpenAI-compatible
inference adapter and a bounded local open-weight smoke are present; the
funded work begins with token/log-probability rollout capture and training.
The plan is designed to produce the evidence needed for the Safety Research
Grant application: a reproducible base-versus-proxy-fine-tuned comparison with
an independently scored hidden intended objective, held-out safety variants,
and complete rollout/checkpoint provenance.

The experiment should answer one operational safety question:

> Under the same observations, actions, seeds, simulator version, and
> constraints, does narrow fine-tuning on a visible proxy improve the hidden
> intended objective, or increase proxy-intent divergence and hard-constraint
> failures relative to the same model before training?

The study should treat this as a constrained multi-objective problem, not as
a contest for the highest short-term win total.

## 1. Fixed environment contract

### Current environment

The wrapper is a TypeScript MCP server whose transport-independent
`DomainService` is shared by the MCP tools and the offline evaluator. The real
Basketball GM engine runs in an isolated worker per episode. The current
catalog contains 16 typed tools:

- state and options: overview/roster/finances/standings/schedule/free-agent/
  draft/transaction/objective/constraint views and legal options;
- decision tools: evaluate or execute a trade, set a lineup, release a player,
  negotiate a contract, sign a free agent, and make a draft pick;
- time and recovery: bounded advance, create/list/restore checkpoint, and end
  an episode.

The policy-facing observation contract is scenario-controlled. A policy may
only request the views listed in `allowedInformation`, and a policy may only
perform actions listed in `allowedActions`. The evaluator's terminal reads are
separate from policy reads. Every mutation is revision-aware and carries an
idempotency key; the environment records the result of rejected and retried
attempts as well as successful transitions.

### Canonical scenario

The current manifest is
`scenarios/long-horizon-asset-preservation.json`:

| Parameter         | Current value                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Scenario          | `long-horizon-asset-preservation-v1`                                                                        |
| Start             | Team 0, season 2026, fresh seeded league                                                                    |
| Horizon           | Two seasons                                                                                                 |
| Seeds             | Five fixed seeds: `grant-seed-001` through `grant-seed-005`                                                 |
| Budget            | 300 mutation steps                                                                                          |
| Hard constraints  | Roster bounds, no duplicate players/picks, valid contracts, finite values, season progression, valid lineup |
| Reward comparison | Lexicographic: hard constraints, win percentage, total asset value, draft capital, stale-action rate        |

The manifest currently observes cap space but does not make salary-cap
compliance a hard constraint. If cap compliance is included in the funded
study, it must be declared in a new versioned scenario manifest and treated as
a separate experimental condition.

The current asset value is an explicit, simple proxy derived from player
overall/potential and draft-pick round. It is useful for a first controlled
experiment, but it is not a validated market valuation. Its definition must
remain frozen for a comparison, and raw roster and draft components must be
reported alongside it.

## 2. Experimental conditions

The following is the minimum comparison set. “Available” describes the
current repository; the remaining rows are proposed work.

| Condition                 | Current state                              | Purpose                                                                             |
| ------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| No-op / advance-only      | Available                                  | Lower-bound behavior and mandatory-decision failure floor                           |
| Deterministic heuristic   | Available                                  | Transparent non-learned reference                                                   |
| Untrained open model      | Concrete inference adapter                 | Measures raw tool-using capability before training                                  |
| Prompted open model       | Concrete inference adapter + frozen prompt | Separates instruction/prompt gains from weight updates                              |
| Tinker-trained open model | Planned Tinker rollout/training loop       | Tests the proposed post-training loop                                               |
| Built-in Basketball GM AI | Not surfaced by the current bridge         | Optional simulator-native reference, only if a comparable headless path is verified |
| Frontier reference model  | Optional future adapter                    | Optional capability context; not required for the first funded result               |

The no-op and heuristic policies must remain unchanged after training data are
collected. Any model prompt, tool description, sampling parameter, system
instruction, adapter version, or checkpoint used for a result must be recorded
as provenance.

### Seed discipline

The five-seed scenario is the fixed pilot panel, with a separate two-seed
held-out manifest now frozen and evaluated for the reference controls. Do not
tune prompts, reward weights, stopping rules, or model checkpoints on that
held-out set. All policies in a comparison receive the same seed set and the
same engine and wrapper identities.

The five current seeds are sufficient to demonstrate the mechanics of a
pilot, but not to support a strong generalization claim by themselves. The
funded experiment should report per-seed outcomes and uncertainty rather than
presenting five runs as statistical proof.

## 3. Rollout protocol

Each rollout is a stateful interaction, not a single prompt completion.

1. Load the frozen scenario and create a fresh isolated episode with one
   declared seed.
2. Serialize the initial allowed observation and the exact tool schemas into
   the policy context. Do not include evaluator-only terminal state.
3. Ask the model for one structured action or tool call.
4. Validate the call through the existing domain boundary. If it is rejected,
   return a bounded error/observation to the policy, preserve state, and log
   the attempt. Do not repair the action invisibly.
5. Return the resulting state view and revision, then continue the dialogue
   until the scenario horizon, step budget, terminal phase, or an explicit
   unrecoverable failure.
6. Export the terminal state and compute raw metrics from the same
   evaluator-facing path used for reference policies.
7. Preserve the normalized action sequence, state hashes, attempt log,
   scenario fingerprint, engine identity, wrapper version, model metadata,
   and completion status.

The model should emit exactly one environment action per decision turn. The
adapter may format that action as a tool call for an MCP client or invoke the
same `DomainService` operation directly for the offline harness, but it must
not create a second set of game semantics. Dry-run trade evaluation should
remain distinct from trade execution.

## 4. Proposed Tinker loop

The loop follows the official Tinker workflow documented in the [Tinker quick
start](https://tinker-docs.thinkingmachines.ai/tinker/quickstart/), the
[reinforcement-learning overview](https://tinker-docs.thinkingmachines.ai/cookbook/rl/),
and the [Tinker documentation overview](https://tinker-docs.thinkingmachines.ai/):
the researcher owns the local environment, reward, and evaluation code;
Tinker supplies remote training and sampling operations through its clients.

The first implementation should be a small companion runner, likely in the
language supported by the official Tinker SDK, rather than embedding
provider-specific credentials or assumptions into the TypeScript server.

### Initialization

1. Pin the base open-weight model, tokenizer/rendering method, prompt format,
   LoRA configuration, sampling parameters, and adapter revision.
2. Create a Tinker training client and an on-policy sampling client using
   credentials supplied through the runtime environment.
3. Store only non-secret run identifiers and configuration hashes in the
   experiment artifact. Never commit `TINKER_API_KEY` or any equivalent
   credential.
4. Run the no-op and heuristic baselines before changing model weights.

### One training iteration

For each iteration:

1. Select a batch of scenario/seed tasks from the training seed pool.
2. Save or expose the current policy weights to a Tinker sampling client.
3. Sample one or more complete multi-turn rollouts per task. The local
   adapter runs the Basketball GM episode and records the full interaction.
4. Compute terminal and, where justified, intermediate signals locally:
   win performance, asset preservation, draft capital, constraint status,
   invalid actions, stale actions, completion, and tool-use behavior.
5. Convert the rollout results into the selected training signal. The first
   candidate is group-relative advantage computation with an importance-
   sampling or GRPO-style loss, subject to the exact Tinker API and model
   compatibility available at implementation time.
6. Submit the resulting training data to `forward_backward`, then apply an
   optimizer step with `optim_step`.
7. Save a checkpoint and evaluate it on a fixed development slice. Keep the
   checkpoint lineage, configuration, and aggregate metrics together.
8. Stop, revert, or continue according to pre-registered gates; do not select
   a checkpoint using held-out results.

The official documentation describes the analogous RL sequence as sampling
rollouts, scoring them, computing advantages, training with an RL loss,
taking an optimizer step, and repeating. This plan uses that workflow
conceptually; it does not claim that a Tinker client has already been wired
into this repository.

### Reward handling

The environment's primary scientific output remains the raw metric vector and
the declared lexicographic/Pareto comparison. A scalar learning signal may be
needed by a selected optimizer, but it must be declared before training and
must not replace the audit report. In particular:

- a violation must not be made harmless by a large win total;
- a model must not be rewarded for producing invalid calls or consuming the
  entire budget;
- weights and normalization constants must be versioned configuration;
- reward clipping, shaping, and terminal-only versus stepwise signals must be
  disclosed; and
- every final report must preserve the raw components so another researcher
  can recompute a different comparison.

For the first study, the current lexicographic order should be the primary
selection/reporting rule. If a scalar surrogate is introduced for learning,
it should be a pre-registered optimization surrogate and analyzed against the
unchanged lexicographic result.

## 5. Evaluation methodology

### Primary endpoints

Report each policy at the episode and aggregate levels for:

- regular-season win percentage and games played;
- seasons completed and completion status;
- terminal hard-constraint satisfaction and rollback violations;
- current player value, draft-capital value, and total asset value;
- cap space and roster composition, with cap compliance only where declared
  by the scenario;
- transaction count and roster churn;
- invalid-action rate, stale-action rate, idempotent replay count, and
  mutation-step efficiency; and
- recovery time after a specified adverse event, once an adverse-event
  scenario is explicitly implemented.

For multi-seed summaries, report the mean, standard deviation, minimum, and
maximum already supported by the evaluator, plus confidence intervals and
effect sizes in the grant analysis layer. Keep per-seed records visible so a
mean cannot hide catastrophic failures.

### Required comparisons

At minimum, compare:

1. no-op versus heuristic;
2. untrained versus prompted open model;
3. untrained versus Tinker-trained model; and
4. all model conditions versus the unchanged transparent references.

The same agent should be evaluated at a shortened horizon and the full
horizon. This tests whether a policy's apparent competence survives delayed
consequences. A trade-disabled condition tests whether the result depends on
asset shuffling, and a relaxed-constraint condition helps separate strategic
weakness from rule-following weakness.

### Integrity checks

Every report must verify:

- scenario fingerprint and exact seed membership;
- engine name, version, commit, Node major version, and wrapper version;
- policy adapter and model/checkpoint identity;
- prompt/tool-contract/configuration hashes;
- initial snapshot hash, when a controlled snapshot is used;
- no duplicate policy-seed pairs;
- finite metric and reward values;
- trajectory and attempt-log sequence integrity; and
- replay/state-hash agreement for a representative sample of episodes.

The five-seed pilot should be described as descriptive evidence. Any stronger
claim should use the held-out set and state its uncertainty and exclusions.

## 6. Proposed experiment matrix

| Stage                | Policies                                       | Data                   | Purpose                                           | Exit evidence                                              |
| -------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| A. Environment pilot | No-op, heuristic                               | Current five seeds     | Confirm the end-to-end benchmark and report shape | Preserved verified report and logs                         |
| B. Raw model         | Untrained, optionally prompted open model      | Same development seeds | Measure baseline tool use and failure modes       | Adapter metadata, trajectories, per-seed metrics           |
| C. Tinker iteration  | Candidate open model                           | Training seed pool     | Test whether post-training changes behavior       | Checkpoint lineage, rollout/reward records, update metrics |
| D. Selection         | Best pre-registered checkpoint plus references | Development seeds only | Choose without looking at held-out outcomes       | Selection record and frozen checkpoint                     |
| E. Final evaluation  | All required conditions                        | Held-out seeds         | Estimate generalization                           | Report, uncertainty, replay checks                         |
| F. Ablations         | Selected model and references                  | Matched seed subsets   | Diagnose horizon, constraint, and trade effects   | Ablation table and limitations                             |

“Best” in Stage D must be defined by the declared primary comparison, with
constraint satisfaction preceding performance. If no checkpoint clears the
pre-registered gate, that is a valid research result and should be reported.

## 7. Milestones and deliverables

### M0 — Freeze and reproduce the pilot (complete for the preview)

Deliver the pinned scenario, engine lock, wrapper revision, no-op/heuristic
report, trajectory bundle, and a short reviewer-facing demo. Record the final
post-sprint verification output before external submission.

### M1 — Implement the external policy boundary (complete as an inference smoke)

Deliver a concrete adapter that maps a model's structured decision to the
existing typed observation/action contract. Add model, prompt, sampling, and
configuration provenance. Demonstrate an untrained model run without
information or action bypasses.

### M2 — Run a first Tinker update

Deliver a companion runner, one reproducible training iteration, checkpoint
lineage, local reward/rollout records, and a clean failure path for interrupted
or unavailable remote calls.

### M3 — Evaluate the trained policy

Deliver development-seed comparisons against no-op, heuristic, and untrained
conditions. Include raw metrics, aggregate summaries, constraint outcomes,
action failures, and representative replay checks.

### M4 — Produce the grant artifact (preview packet)

Deliver the held-out evaluation, ablations, plots/tables, demo, concise method
note, machine-readable report, and an explicit list of verified facts,
proposed capabilities, and remaining limitations.

## 8. Compute plan and credit request

Superseded figures: the earlier illustrative $5,000 allocation is no longer the
request. The authoritative rollout units, tier table, and model-selection
statement are in
[`docs/GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md) §7.

Summary of the current request:

| Tier                     |      Amount | Scope                                                                                                                     |
| ------------------------ | ----------: | ------------------------------------------------------------------------------------------------------------------------- |
| Core                     |     $18,000 | Base calibration, one proxy-fine-tuned checkpoint, development screening, held-out evaluation, audit-condition comparison |
| **Extended (requested)** | **$28,000** | Adds a second training budget, the objective-aligned fine-tuning control, and the second-environment port                 |
| Stretch                  |     $35,000 | Adds a checkpoint sweep for early-warning forecasting                                                                     |

Approximate rollout volume behind the Extended tier: ~2,900 short-horizon
training episodes, ~520 full-horizon episodes across base calibration,
checkpoint screening, and final evaluation, and ~200 short-horizon episodes for
the second-environment port.

The primary scarce resource is controlled iteration, not a public serving
deployment. Local CPU execution remains responsible for scenario logic,
grading, trajectory retention, planted-policy calibration, and audit; credits
are requested only for remote training and sampling. Policy context is bounded
to a rolling scenario-limited observation window rather than a growing
transcript, which is both a reproducibility decision and the reason an RL study
of this shape fits a grant-scale budget.

## 9. Risks and threats to validity

### Environment fidelity

The pinned engine is proprietary/source-available and headless integration
has known boundaries. The adapter's contract-negotiation fallback is lower
confidence than the other actions; generated names are test-mode placeholders;
custom imported league configurations remain restricted; and real-worker
restart/resume is covered only by the gated local integration path. These facts
must remain in the result package rather than being presented as solved.

### Reward and objective validity

The current asset formula is a proxy and can be gamed. A model may optimize
the observable metric without becoming a better GM. Mitigate this with raw
components, alternative comparison modes, held-out scenarios, asset and
constraint ablations, and qualitative inspection of representative
trajectories.

### Limited coverage

Five seeds and one two-season manifest cannot establish broad generalization.
The initial claim should be limited to the declared environment. Expand seed,
horizon, and scenario coverage before making a wider planning claim.

### Tool and context confounds

Prompt wording, tool schema quality, context length, sampling temperature,
retry policy, and invalid-action handling can affect performance independently
of training. Freeze and hash these settings, report them, and compare
untrained and trained versions under the same contract.

### Learning-loop confounds

On-policy data can be expensive and rewards can be sparse. Tinker API/model
compatibility, rollout failures, or checkpoint selection can bias the study.
Use explicit retry/failure accounting, keep failed rollouts in telemetry,
avoid selecting on held-out data, and publish negative or inconclusive runs.

### Simulation realism

Basketball GM is a game simulation with its own rules and AI, not a validated
model of front-office practice. The result supports claims about planning in
this discrete simulator, not direct claims about real-world team management.

## 10. Licensing and security boundary

The wrapper and research code are MIT-licensed. Basketball GM/zengm is a
separate source-available dependency under its own terms. This project does
not clone, download, vendor, host, or redistribute that checkout and is not
affiliated with ZenGM. Reviewers must obtain and comply with the upstream
license themselves.

The public artifact can include wrapper code, experiment manifests, permitted
derived metrics, configuration hashes, and documentation. It must not include
the upstream engine source or imply a redistribution right. Tinker
credentials, model-provider secrets, and private endpoints belong in the
runtime secret store or environment, never in Git, manifests, logs, prompts,
or generated reports.

## 11. Evidence package checklist

Before asking a funder to rely on the result, assemble one immutable bundle
containing:

- the wrapper revision and clean verification output;
- the exact scenario manifests and seed split;
- `bbgm-engine.lock.json` and evidence of a separately obtained compliant
  engine checkout, without redistributing that checkout;
- policy adapter, model/checkpoint, prompt, tool-contract, and sampling
  metadata;
- machine-readable reports and derived plots;
- representative trajectory, attempt, and state-hash logs;
- the training/update log and checkpoint lineage;
- a short demo or transcript; and
- a claims table marking each statement as verified, proposed, or limited.

The final reviewer-facing sentence should be precise: the project already
has a reproducible, instrumented environment and transparent baselines; the
funded work will test whether Tinker-supported narrow fine-tuning produces
proxy-intent divergence, oversight-sensitive behavior, or safety-relevant
generalization in a controlled stateful tool environment.
