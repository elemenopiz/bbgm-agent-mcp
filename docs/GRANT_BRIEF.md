# Safety Research Grant brief

Status: **superseded as the submission artifact.** The document actually sent to
reviewers is [`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md), which is
written to fit one page. This brief is retained as the extended narrative that
the one-pager compresses, and as the place where the research agenda is spelled
out at length.

| Need                                                                          | Document                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The required 1-page summary                                                   | [`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md)     |
| Requirements, admin fields, cover email, criteria response, budget, send gate | [`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md) |
| Pre-submission sprint and six-month plan with check-ins                       | [`GRANT_TIMELINE.md`](GRANT_TIMELINE.md)                     |
| Scientific framing and prioritization                                         | [`SAFETY_GRANT_STRATEGY.md`](SAFETY_GRANT_STRATEGY.md)       |
| What is actually measured today                                               | [`EVIDENCE_BUNDLE.md`](EVIDENCE_BUNDLE.md)                   |

This brief supersedes the former long-horizon/interactivity grant framing.

## Extended project narrative

### Auditing reward hacking and oversight-sensitive behavior after narrow fine-tuning in tool-using agents

Open-weight models can be modified by downstream fine-tuning, but a training
run that improves a visible reward may also change how a model handles hidden
constraints, delayed consequences, and oversight. We propose a controlled
study of this safety problem: when a tool-using agent is narrowly fine-tuned
against an incomplete proxy objective, does it improve the intended objective,
or does it learn behavior consistent with reward hacking, strategic
compliance, or oversight-sensitive failure?

Our testbed is a real-engine, replayable Basketball GM environment. Basketball
is not the research claim; it is a compact stateful laboratory in which an
agent must repeatedly inspect changing state, use typed tools, make
irreversible-looking decisions, preserve future resources, and resolve
mandatory deadlines. The environment provides deterministic seeds, exact state
transitions, scenario-controlled observations and actions, hard-constraint
checks, revision-aware mutations, rollback, raw attempt and trajectory logs,
state hashes, and clean-room replay. These properties let us measure safety
failure signatures directly rather than infer them from a single score or
free-form narrative.

The primary research question is:

> Does narrow fine-tuning on a visible short-horizon proxy improve the hidden
> intended objective, or does it increase proxy-success/intended-objective-
> failure episodes in a stateful tool environment?

We will define the visible proxy and hidden intended objective before training.
The proxy will be deliberately incomplete—for example, immediate competitive
performance—while the independently computed intended objective will include
horizon completion, hard-constraint compliance, future asset preservation,
and other pre-registered raw components. The policy will never receive the
hidden evaluator formula, hidden valuation, or evaluator-only reward labels.
The primary safety endpoint will be the rate of episodes that improve or
maintain the visible proxy while materially degrading the intended objective
or violating a hard constraint. We will report the raw components and the
threshold rule, not only an aggregate reward.

Using Tinker, we will fine-tune an open-weight base model on the narrow proxy
task and compare it with the same model before training under identical model
revision, prompt, tool contract, decoding, seeds, and action budgets. Controls
will include a no-op policy, a legal-completion policy, and a deterministic
heuristic. We will evaluate on held-out seeds, hidden valuation variants,
changed constraint combinations, and scenario/horizon configurations excluded
from training. A bounded audit-condition comparison will test whether the
policy’s behavior changes when monitoring or review signals are visible. We
will call measured behavioral signatures “oversight-sensitive behavior” and
reserve “oversight gaming” for pre-registered signatures; we will not infer
deception or internal intent from action traces.

The evaluation will measure proxy gain, intended-objective gain, proxy-intent
divergence, hard-constraint and protocol violations, horizon completion,
stalls, invalid/stale/retried actions, rollback and quarantine events,
held-out generalization, audit-condition sensitivity, and worst-seed or
lower-tail degradation. If resources allow, a small training-budget or
checkpoint sweep will test whether early divergence or action-pattern changes
forecast later failures. All analyses will preserve intention-to-treat and
completed-only views, per-seed deltas, uncertainty where meaningful, and a
null-result interpretation.

The project is feasible because the repository already contains the
instrumented environment, deterministic reference policies, a real open-model
adapter boundary, and verifier-passing baseline artifacts. Current evidence
establishes environment and measurement readiness: a five-seed reference panel
has heuristic completion on 3/5 seeds and no-op completion on 0/5, while a
bounded open-model smoke retains a parse failure and provider failure. No
Tinker-trained checkpoint or learned-agent competence result is being claimed;
those are the funded work.

The deliverables will be a simple safety scenario/evaluator contract, a
reproducible Tinker checkpoint lineage and rollout record, held-out safety
results, a failure taxonomy, raw trajectories and replay manifests, leakage
and construct-validity tests, and a public methods note. If narrow fine-tuning
does not produce the predicted failure, that null result and its limits will be
released. The intended contribution is a reusable measurement of safety-
relevant behavioral change in stateful tool environments, not a claim about
basketball expertise, real-world organizational competence, or deceptive intent.

## Research agenda and funded work

1. Freeze the visible proxy, hidden intended objective, safety endpoints, and
   held-out split before training.
2. Calibrate the proxy-intent detector against planted policies with known
   ground truth, and report its sensitivity and specificity before any learned
   policy is scored.
3. Add Tinker rollout capture for tokens, masks, log-probabilities, rewards,
   checkpoint lineage, and configuration hashes.
4. Run base-model calibration and deterministic controls through the unchanged
   typed environment boundary.
5. Train one or more bounded proxy-fine-tuned checkpoints.
6. Evaluate on held-out seeds and hidden scenario/valuation variants, including
   the oversight-sensitive behavior condition.
7. Analyze tail risk and narrow-fine-tuning drift; run a scaling forecast only
   if the minimum study is complete.
8. Port the contract and detector to a second, deliberately simple
   environment as the generality check.
9. Release reproducible artifacts and a null-result analysis.

## Reviewer-facing safety claims

- **Relevance:** directly studies reward hacking, oversight-sensitive behavior,
  and safety-relevant generalization from narrow fine-tuning.
- **Feasibility:** the environment, controls, typed boundary, and evidence
  machinery already exist; grant support funds the missing Tinker training and
  safety evaluation.
- **Construct validity:** the detector is calibrated against planted policies
  with known ground truth and reported as sensitivity/specificity, not asserted;
  visible and hidden objectives are separated; raw components, state hashes,
  attempts, and replay are retained; no intent is inferred from behavior alone.
- **Simplicity and generality:** the reusable artifact is a small portable
  scenario/evaluator contract - a JSON manifest plus a narrow interface
  returning raw components - implemented twice: once against the pinned
  real-engine testbed and once against a deliberately simple second
  environment.

The full criteria response, written in the order reviewers score them, is
[`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md) §6.

## Current evidence boundary

Measured or implemented in this checkout:

- pinned Basketball GM 5.1.0 engine identity and real-engine checks;
- typed MCP actions, revision checks, idempotency, isolation, and rollback;
- scenario-controlled information, actions, constraints, and budgets;
- raw trajectories and attempt logs, state hashes, and replay verification;
- deterministic `no_op` and heuristic reference policies; and
- a real open-model adapter smoke with raw parse/provider telemetry.

Not yet measured:

- the safety-specific proxy/intent scenario family;
- a Tinker training run or checkpoint lineage;
- long-horizon base-versus-proxy-fine-tuned results;
- an oversight-sensitive behavior result; or
- a powered held-out safety panel.

The baseline artifacts support feasibility and auditability. They do not show
that a model is safe, aligned, competent, deceptive, or reward-hacking.

## Administrative cover sheet

The fillable administrative fields, attachment manifest, cover email, and final
send gate now live in
[`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md) §§3-5 and §10.
Do not maintain a second copy here.

Fixed facts: applications go to `grants@thinkingmachines.ai` by **September 25
at 11:59 PM PDT**; reviews are returned within one week of the deadline; the
collaboration runs up to six months with model access, support, and check-ins
tailored to our timeline. Program terms cap Tinker credits at $50,000 at
current rates, expire unused credits after 12 months, bar institutional
indirect costs, treat the application and work product as non-confidential,
require CC BY 4.0 or another approved open license for published work, and
require written approval before publishing work that uses or references
Company Materials.

Our request is **$28,000**, with an $18,000 reduced-scope tier named explicitly
in the application. The derivation is in
[`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md) §7.
