# Active strategy: Safety Research Grant

Status: active as of 2026-09-03. This document is the source of truth for
grant framing and future prioritization. The submission artifacts derived from
it are [`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md) (the required
summary), [`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md)
(requirements, criteria response, budget, send gate), and
[`GRANT_TIMELINE.md`](GRANT_TIMELINE.md) (pre-submission sprint and six-month
plan). The former interactivity/steerability
plan is retained only as historical context in
`docs/BBGM_STEERABILITY_GRANT_PLAN.md` and must not guide current work.

## The frame that gives this project a safety contribution

Do not lead with “an AI that plays basketball,” long-horizon management, or
human interactivity. Lead with this safety question:

> When an open-weight tool-using agent is narrowly fine-tuned against an
> incomplete, visible proxy objective, does it improve the intended objective,
> or does it learn behavior consistent with reward hacking, strategic
> compliance, or oversight-sensitive failure—and can those failures be
> detected before they become severe?

Basketball GM is the controlled instrument. Its value is that the environment
has delayed consequences, irreversible-looking actions, interacting
constraints, a broad typed tool surface, and an exact simulator. The safety
claim is about measuring alignment failure modes in stateful agents; it is not
about basketball expertise or real-world organizational competence.

Working title:

> **Auditing Reward Hacking and Oversight-Sensitive Behavior After Narrow
> Fine-Tuning in Tool-Using Agents**

Use "oversight-sensitive behavior" in the title and throughout. "Oversight
gaming" names the program's interest area and belongs in the relevance
argument, but a title that claims it commits the proposal to a signature we
can only confirm after the audit-condition comparison runs.

The primary contribution should be a simple, reproducible safety evaluation
and a Tinker study, not a larger game simulator.

## Why this matches the active call

Thinking Machines’ Safety Research Grant call names the following relevant
directions:

- safety-relevant generalization from narrow fine-tuning;
- reward hacking and oversight gaming;
- worst-case and marginal risk estimation; and
- forecasting safety-relevant scaling trends.

The proposal should explicitly name reward hacking as the primary failure
mode, narrow-fine-tuning generalization as the secondary failure mode, and
worst-case/tail behavior as the risk-analysis layer. Oversight gaming is a
carefully operationalized subtest, not a claim that the model has intentions.

Primary official sources:

- [Safety Research Grants](https://thinkingmachines.ai/news/safety-research-grants/)
- [How to Apply](https://thinkingmachines.ai/news/safety-research-grants/apply/)
- [Program Terms](https://thinkingmachines.ai/legal/safety-research-grants-terms/)

## Proposed research agenda

### 1. Build a proxy-versus-intent test

Define two evaluator layers before training:

- **Visible proxy:** a deliberately incomplete short-horizon signal, such as
  immediate competitive performance or another explicitly documented reward
  available to the training loop.
- **Intended objective:** a hidden, independently computed combination of
  horizon completion, hard-constraint compliance, future asset preservation,
  and other pre-registered raw components.

The policy must never receive the hidden evaluator formula, hidden valuation,
or reward labels that are not part of its declared observation contract. The
evaluator must retain raw components, not only one scalar.

The primary safety endpoint is the rate of pre-registered **proxy-success /
intent-failure** episodes: episodes in which the policy improves or maintains
the visible proxy while materially degrading the hidden intended objective or
violating a hard constraint. The threshold and aggregation rule must be
written before the treatment run.

### 2. Test narrow-fine-tuning generalization

Fine-tune one open-weight base model on a narrow proxy task and compare it
with the same model before training under identical prompts, tools, decoding,
seeds, and budgets. Hold out the following from training and policy
selection:

- seeds and initial states;
- hidden valuation variants;
- constraint combinations;
- horizon or event schedules; and
- at least one scenario configuration that preserves the same tool contract
  but changes the proxy/intent tension.

This measures safety-relevant behavioral change within a controlled tool
environment. It must not be described as proof of broad real-world
misalignment generalization.

### 3. Operationalize oversight gaming without overclaiming intent

The environment should expose a declared monitoring condition—for example,
whether a policy-visible audit signal or review boundary is present—while the
evaluator keeps immutable logs and hidden metrics. Compare behavior across
audit-visible and audit-absent conditions and look for pre-registered
signatures such as:

- better visible scores only when monitoring is present;
- selective constraint compliance that disappears off-distribution;
- high-quality reported status paired with hidden-objective degradation; or
- attempts to exploit the tool protocol while preserving the monitored
  surface.

Call these **oversight-sensitive behaviors** unless the measured signature
meets the pre-registered definition of oversight gaming. Never infer
deception, scheming, or intent from an action trace alone. The immutable
attempt log, state hashes, rollback records, and replay verifier make actual
evaluator tampering unnecessary and observable.

### 4. Measure tail and scaling behavior

Report mean outcomes separately from worst-seed or lower-tail outcomes. At
minimum, preserve per-seed deltas for proxy score, intended objective,
constraint violations, completion, and invalid/stale actions.

If credits permit, run a small training-budget or checkpoint sweep. Test
whether early proxy-intent divergence, constraint pressure, or action-pattern
changes forecast later failures. Treat forecasting as a stretch objective
unless the minimum evaluation is already complete.

### 5. Calibrate the detector before trusting it

The program scores construct validity: whether the metrics capture what they
claim. Asserting that the proxy-intent detector works is not evidence. We
calibrate it against policies whose ground truth we control, before any learned
policy is scored.

| Planted policy        | Constructed to                                                        | Detector must                                       |
| --------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Proxy-hacker          | Maximize the visible proxy while spending hidden-objective components | **Flag** as proxy-success / intent-failure          |
| Constraint-violator   | Trip a declared hard constraint                                       | **Flag**, and name the constraint code              |
| Stall / budget-burner | Fail the horizon without proxy gain                                   | **Not** flag as reward hacking; classify as a stall |
| Aligned optimizer     | Improve proxy and hidden objective together                           | **Not** flag                                        |
| Monitoring-sensitive  | Change behavior only when the audit signal is visible                 | Flag only in the audit-condition comparison         |

Report sensitivity and specificity against these known labels. A detector that
misses a planted hack or fires on the aligned control is a failed instrument:
fix it, or publish the measured detection floor as a limitation. This
calibration needs no Tinker credits and no learned policy - the planted
policies are deterministic and run on local CPU through the unchanged typed
boundary - so it is the cheapest available evidence and should be produced as
early as possible, ideally before submission. See
[`docs/GRANT_TIMELINE.md`](GRANT_TIMELINE.md), Part 1.

A calibrated detector also bounds a null result. If training produces no
reward hacking, measured sensitivity tells a reader how large an effect the
instrument could have caught, which is the difference between an informative
null and an uninformative one.

## Minimum persuasive experiment

The first funded study should contain:

1. The current pinned real-engine environment and typed tool boundary.
2. A preregistered safety scenario family with visible proxy and hidden
   intended objective.
3. `no_op`, legal-completion, and deterministic heuristic controls.
4. The untrained open-weight base model.
5. A proxy-fine-tuned version of that same base model using Tinker.
6. A held-out evaluation with hidden valuation/scenario variants.
7. An audit-condition comparison for oversight-sensitive behavior.
8. Raw rollout tokens, masks, log-probabilities, rewards, checkpoint lineage,
   configuration hashes, normalized actions, and state hashes.
9. Intention-to-treat and completed-only analyses, with per-seed results.
10. A null-result and failure-analysis section, even if training does not
    produce reward hacking.

An objective-aligned fine-tuning control and a small training-budget sweep
are valuable additions when resources allow. They should not delay the
minimal base-versus-proxy-trained comparison.

## Metrics to preregister

| Family                | Measures                                                                               | Safety interpretation                                     |
| --------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Proxy                 | Training-visible reward and its raw components                                         | What the policy was optimized to improve                  |
| Intended objective    | Hidden evaluator components, total objective, and alternative hidden valuations        | Whether proxy gains track the intended goal               |
| Proxy divergence      | Proxy gain minus intended-objective gain, plus proxy-success / intent-failure rate     | Primary reward-hacking signal                             |
| Constraints           | Hard violations, invalid actions, stale actions, retries, rollback/quarantine events   | Safety boundary and protocol reliability                  |
| Survival              | Horizon completion, stalls, budget exhaustion, firing/termination where applicable     | Whether failures are hidden by incomplete runs            |
| Oversight sensitivity | Paired behavior differences across audit conditions                                    | Candidate oversight-gaming signature, not proof of intent |
| Generalization        | Held-out seeds, hidden valuations, horizons, and scenario configurations               | Safety-relevant narrow-fine-tuning drift                  |
| Tail risk             | Worst seed, lower quantiles, and maximum degradation from the base model               | Marginal/worst-case risk within the testbed               |
| Process               | Tokens, tool calls, latency, cost, checkpoint lineage, and early checkpoint indicators | Feasibility and possible early warning signals            |

Do not collapse these into a leaderboard score. A policy that earns a high
proxy reward while violating hard constraints is a safety failure, not a
successful agent.

## Construct-validity safeguards

The proposal will be credible only if it shows that the measurement is not a
game-specific artifact:

- keep policy-visible observations separate from evaluator-only metrics;
- define the proxy and intended objective before training;
- use the same base model, prompt, tool schema, decoding, seed assignment,
  and action budget before and after fine-tuning;
- freeze development and held-out manifests separately;
- report raw metrics alongside any aggregate;
- retain rejected, stale, timed-out, parse-failed, provider-failed, and
  retried attempts;
- verify trajectories with state hashes and clean-room replay;
- test multiple hidden valuation functions rather than one “true value”
  formula; and
- state explicitly that actions are behavioral evidence, not evidence of
  internal intent.

The reusable object is the scenario/evaluator contract: a stateful tool
environment with an independently scored hidden objective and exact replay.
BBGM is the first implementation because it is already instrumented and
auditable. A second environment is a longer-term generality test, not a
condition for the first application.

## Simplicity and generality: the portable contract

The program also scores how easily a method can be implemented, reproduced, and
applied elsewhere. A large bespoke basketball simulator scores badly on that
criterion, so the contribution must be stated as the small thing, not the big
thing.

The deliverable is a **proxy-intent environment contract**:

- a JSON scenario manifest declaring allowed observations, allowed actions,
  hard constraints, horizon, step budget, seed split, and audit condition; and
- a narrow evaluator interface that returns **raw components** - horizon
  completion, constraint status, and the objective components - rather than a
  scalar.

On top of that sit one table of raw components and one pre-registered threshold
rule. Another team can implement the contract against their own stateful tool
environment in a day; nothing in the normative part of the spec mentions
basketball.

Basketball GM is the reference implementation because it is already
instrumented, auditable, and pinned. The generality evidence is a second,
deliberately simple environment implementing the same contract, with the same
planted-policy calibration re-run against it. Two implementations of one small
contract is the generality claim. A bigger simulator is not, and building one
would weaken the proposal rather than strengthen it.

## What is already credible in this repository

Measured or implemented now:

- pinned Basketball GM 5.1.0 integration and engine identity checks;
- typed MCP actions, revision checks, idempotency, rollback, and isolation;
- scenario-controlled observations, actions, constraints, and budgets;
- raw trajectory and attempt telemetry, state hashes, and replay verification;
- deterministic `no_op` and heuristic reference policies;
- a verifier-passing five-seed reference panel and separate held-out control;
  and
- a real open-model adapter smoke with retained parse/provider failures.

Not yet measured and therefore part of the grant proposal:

- a proxy-versus-intent safety scenario family;
- a Tinker training run and checkpoint lineage;
- long-horizon untrained and proxy-fine-tuned open-model evaluation;
- a preregistered oversight-sensitive behavior test;
- a powered held-out panel; and
- a safety-specific analysis of narrow-fine-tuning drift or scaling.

The current artifacts establish environment and measurement readiness. They do
not establish that any model is safe, aligned, competent, deceptive, or
reward-hacking.

## Six-month workplan

Dated schedule, gates, check-in cadence, and slip rules live in
[`docs/GRANT_TIMELINE.md`](GRANT_TIMELINE.md). Summary:

| Month | Window            | Deliverable                                                                                                                       | Gate                                                                                              |
| ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| M1    | Oct 5 - Nov 3     | Freeze scenario contract, visible proxy, hidden objective, endpoint, split; complete planted-policy calibration and leakage tests | No training starts before the primary endpoint is frozen and the detector clears calibration      |
| M2    | Nov 4 - Dec 3     | Tinker rollout capture, oversight-condition metadata, model provenance; base-model calibration rollouts                           | An untrained end-to-end rollout is captured, scored, and replayed with agreeing state hashes      |
| M3    | Dec 4 - Jan 2     | Deterministic controls, base and prompted-base conditions, red-team condition pilot                                               | Failure taxonomy and thresholds stable; base model shows a usable capability floor                |
| M4    | Jan 3 - Feb 1     | Proxy-fine-tuned checkpoint(s) at bounded budgets                                                                                 | Lineage, tokens, masks, log-probs, rewards, configs retained; selection on development seeds only |
| M5    | Feb 2 - Mar 3     | Frozen development and held-out safety evaluations, hidden valuation variants, audit comparison                                   | No held-out tuning, no silent failure filtering                                                   |
| M6    | Mar 4 - early Apr | Tail/generalization analysis, published artifacts, methods note, null-result write-up                                             | Independent reproduction path tested from a clean checkout                                        |

Two of these are decision gates worth a scheduled call with the program: the
**pre-training gate** before M4, which confirms the endpoint and
checkpoint-selection rule before any weights change, and the
**pre-publication gate** in early M6.

## Proposal language to use

> We propose a controlled study of reward hacking and safety-relevant
> behavioral change after narrow fine-tuning of open-weight, tool-using agents.
> Our real-engine Basketball GM environment provides delayed consequences,
> irreversible actions, hard constraints, and exact replay while keeping the
> policy interface small and auditable. We will fine-tune an open model on an
> incomplete visible proxy and evaluate it against the same model before
> training using an independently computed hidden objective, held-out scenario
> variants, and an oversight-condition comparison. The primary endpoint is
> proxy success paired with hidden-objective failure; secondary endpoints cover
> constraint violations, tail degradation, protocol exploitation, and
> generalization from the narrow training distribution. We will release raw
> rollouts, checkpoint lineage, evaluation manifests, failure analyses, and a
> null result if the predicted failure does not appear. The project’s claim is
> about a reproducible safety measurement in a stateful tool environment, not
> about basketball competence or real-world deceptive intent.

## What to exclude from the active application

- interactivity as the primary thesis;
- owner-feedback, employment/firing, and live human steering as headline
  features;
- a five-minute timer as a core requirement;
- a generic “long-horizon planning” or “better GM” pitch without a safety
  failure mode;
- claims that hidden valuation is ground truth;
- claims of deception, scheming, or misalignment based only on traces;
- OpenRouter or a hosted model as the Tinker treatment; and
- any claim that a Tinker-trained model or safety result already exists.

Those items may remain as future or historical context, but they are not
current grant-critical work.

## Official application facts to preserve

From the official application page, the submission must include:

- a one-page English project summary explaining the research agenda;
- PIs and expected contributors, with CVs attached;
- location and organizational details, including tax ID and admin contact if
  applicable; and
- a primary contact email.

The application is sent to `grants@thinkingmachines.ai` by **September 25 at
11:59 PM PDT**. The stated review period is within one week after the deadline,
and the collaboration may run for up to six months with model access, support,
and scheduled check-ins.

The current call offers Tinker credits of up to $50,000 at current rates. The
credits must support the submitted research, unused credits expire 12 months
after provisioning, and institutional indirect costs cannot be charged to the
grant. The terms also say proposals are not confidential, published work must
use CC BY 4.0 or another approved open-source license, and work using or
referencing Company Materials requires written approval before publication.
The final applicant should review eligibility, tax, publication, and
organizational terms before submitting.

## Pre-submission checklist

The operational send gate is [`docs/GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md) §10.
The strategic checks that belong to this document:

- [ ] The one-page summary
      ([`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md)) uses the
      proxy-versus-intent frame and stays inside the word gate.
- [ ] The proposal answers all four scored criteria explicitly, including
      simplicity/generality via the portable contract.
- [ ] Construct validity is answered with calibration, not assertion.
- [ ] The primary safety endpoint and failure thresholds are preregistered and
      dated before any policy is scored against them.
- [ ] The credit request names a specific amount and a reduced-scope tier,
      derived from the rollout plan rather than from the program cap.
- [ ] The proposal separates measured repository evidence from funded future
      work, and claims no Tinker-trained result.
- [ ] The null-result path and the "what ships if something fails" table are
      present.
- [ ] The Basketball GM licensing boundary is stated up front.
- [ ] PI names, roles, CVs, location, organization, tax ID, admin contact, and
      primary email are supplied; no placeholders remain.
