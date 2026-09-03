# Master plan: research case, pressure test, and build schedule

Single source of truth for the Safety Research Grant application. Supersedes
the planning fragments in `BUILD_PLAN.md`, `GRANT_TIMELINE.md`, and
`SAFETY_GRANT_STRATEGY.md`, which should be consolidated into this document
before submission.

Deadline: **September 25, 11:59 PM PDT.** Send target: **September 23.**

---

# Part I - What we are doing and why

## 1. The research question

Fine-tuning a model on a narrow task can degrade its behavior in areas the
training never touched. The established demonstrations of this are almost
entirely **single-turn**: a model is fine-tuned on some narrow corpus, and its
text output becomes broadly worse in unrelated ways.

Nobody has established whether the same thing happens to **agents** - models
that take long sequences of actions, where consequences arrive many steps after
the decision that caused them.

> **Our question:** does narrowly fine-tuning a model on an innocuous,
> unrelated task degrade its safety-relevant behavior as an agent - its
> rule-following, its honesty about its own actions, and its behavior in
> environments it was never trained on?

## 2. Why the answer matters

Every open-weight model gets fine-tuned downstream. Almost none of that
fine-tuning is safety-motivated - it is people adapting a model to a narrow
business task with whatever signal is cheap to collect. If narrow adaptation
silently degrades agentic safety behavior, then the safety properties a
developer measures at release do not survive contact with the deployment
ecosystem, and the degradation is invisible to the person who caused it.

That is a measurement gap, not a theoretical worry. The contribution is a way
to detect it.

## 3. The move that makes this more than a basketball result

The finding is not about basketball. **The finding is about transfer.**

We fine-tune on basketball GM decisions. We then measure safety behavior in a
**different environment the model was never trained on**. If rule-following and
honesty degrade there, the source domain being basketball is what makes the
result strong rather than weak:

> We fine-tuned a model on an innocuous sports-management task, and its
> rule-following and honesty degraded in an unrelated environment.

The more mundane and less safety-adjacent the training data, the more
surprising and more general the result. Basketball is close to ideal as a
source domain precisely because nothing about it is safety-flavored.

This is the same shape as the known narrow-fine-tuning results, moved from
single-turn text into multi-turn agentic behavior, which is where it actually
matters and where it has not been shown.

## 4. Why Basketball GM is the right environment

Studying this needs an environment with an unusual combination of properties.
Most candidates fail on at least one.

| Property                         | Why it is required                                                 | BBGM                                                                      |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Multi-turn tool use              | Agentic behavior cannot be measured in one shot                    | Hundreds of typed actions per episode                                     |
| **Delayed consequences**         | The failure mode is sacrificing later outcomes for immediate score | Decisions surface seasons later                                           |
| Irreversible actions             | Rollback-free choices are what make planning matter                | Trades and releases cannot be undone                                      |
| **Uncontrived proxy/intent gap** | A gap designed by the eval author proves little                    | "Win now vs. build for the future" is a real, naturally-occurring tension |
| Mechanically checkable rules     | "Did it break a rule" must not be a judgment call                  | Roster bounds, contract validity, duplicate ownership                     |
| Ground truth about what happened | Needed to catch misreporting                                       | Attempt logs, state hashes, exact replay                                  |
| Determinism                      | Needed for before/after comparison                                 | Fixed seeds, pinned engine                                                |
| Zero marginal cost               | RL and dose-response need many episodes                            | Runs locally on CPU                                                       |

Compared with the alternatives:

- **Chat and text evals** have no state, no delayed consequences, and no
  irreversibility. They cannot show the effect we are looking for.
- **Coding agents** are strong on capability but the intended objective largely
  collapses to "tests pass," which is a narrow proxy/intent gap. They are also
  expensive and non-deterministic.
- **Web agents** cannot be replayed, offer no ground truth, and taking real
  actions introduces its own hazards.
- **Purpose-built toy environments** are contaminated by design: the author
  chose the failure mode, so finding it demonstrates little.

Basketball GM's dynamics were built over fifteen years by people who had never
heard of AI evaluations. The proxy/intent tension was not authored to trap a
model - it is what the domain actually contains. That is a construct-validity
argument no purpose-built environment can make.

**Honest limitation.** BBGM is a game simulator, not a model of real
organizations. Results support claims about a mechanism - narrow fine-tuning
degrading agentic safety behavior - not claims about deployed systems making
real decisions. The out-of-domain transfer test is what carries the claim
beyond basketball, and it is the reason the second environment is essential
rather than decorative.

---

# Part II - Pressure test

An honest assessment. The point is to fix what is fixable and stop pretending
about what is not.

## 5. The case against funding this

**5.1 The team is the weakest element.** A 19-year-old undergraduate with no
research record, applying against academic labs and established safety
organizations. A senior PhD student as co-investigator materially helps, but
only if they are actually attached before submission - a hoped-for advisor is
worth nothing on the application.

_Fixable: partially. Get the co-investigator committed in writing._

**5.2 "Basketball simulator" is a bad first impression.** A reviewer gives each
proposal ten to twenty minutes. "AI plays basketball manager" pattern-matches to
a hobby project. The transfer framing in §3 is the only thing that survives that
first reaction, so it must be in the first two sentences - not on page two.

_Fixable: yes, entirely through framing._

**5.3 The "so what" objection.** A skeptic says: you showed a model fine-tuned
on basketball plays basketball short-sightedly. This is the single strongest
objection, and the **only** answer is out-of-domain transfer. Without a second
environment, the result is a domain-specific curiosity.

_Fixable: yes, and it makes the second environment non-optional._

**5.4 The repository looks over-documented and under-measured.** Nineteen
markdown files of process scaffolding around one unrun experiment. In 2026 that
pattern reads as generated padding, and it actively damages credibility. The
ratio of documentation to measured results must invert before submission.

_Fixable: yes. Delete most of the documents._

**5.5 No capable model has ever completed an episode.** The only model run is a
135M-parameter smoke test that produced parse failures. If a competent model
cannot reliably drive this tool surface, the entire proposed experiment is
impossible - and a reviewer will notice that this has not been demonstrated.

_Fixable: yes, cheaply, and it is now a pre-deadline priority. See Agent 6._

**5.6 Contamination risk.** Basketball GM is a public game; a model may have
absorbed both the domain and possibly the software. This confounds capability
measurement and must be named as a threat to validity rather than discovered by
a reviewer.

_Not fixable, but disclosable._

**5.7 Six months is a long commitment against a full course load.** Delivery
risk is real and reviewers price it in.

_Partially fixable: honest staffing statement, conservative scope, a
co-investigator who can carry work._

**5.8 SFT is cheap, so why do we need $15,000?** A fair question. The answer is
dose-response: many checkpoints across several data volumes and step counts,
plus heavy sampling to evaluate each one across seeds and two environments.
The budget must show that arithmetic, or it looks padded.

_Fixable: show the rollout math._

## 6. The case for funding it

**6.1 A working artifact.** Most proposals are entirely promise. This one has a
pinned real engine, a typed action boundary, deterministic controls, state
hashing, and verified replay - running today. That is genuinely uncommon and it
is the strongest thing in the application.

**6.2 Provable trajectories.** Very few environments can demonstrate that the
scored trajectory is the trajectory that occurred. This is what makes the
self-report honesty measurement possible at all, and honesty measurement
against ground truth is rare and valuable.

**6.3 The calibration idea shows research taste.** Validating a detector
against planted policies with known ground truth, and reporting its misses,
is what a careful researcher does. It is also directly responsive to a stated
selection criterion.

**6.4 Credits, not cash.** The marginal cost of a small allocation is compute.
That lowers the bar for an unusual bet considerably - but only for a _small_
ask attached to a concrete deliverable.

**6.5 The question is real and the timing is right.** Agentic narrow-fine-tuning
transfer is an open question that people care about now.

## 7. Verdict

As currently constituted, the most likely outcome is a decline - the team is
the problem, not the idea. The realistic goal is not to beat established labs
on their terms; it is to be the **cheap, unusual, well-instrumented bet** that
a program officer can approve at a small allocation without much risk.

Three things move this from "interesting but no" toward that:

1. **A committed co-investigator**, named on the application.
2. **A completed calibration table**, which no other unfunded applicant will
   have.
3. **Evidence that a capable model can actually operate the environment.**

Everything else in this plan is secondary to those three.

---

# Part III - What we are telling Thinking Machines we will do

The six-month program, stated concretely enough to be held to.

## Phase 1 - Months 1: finish the apparatus

Complete the planted-policy calibration on the full seed panel. Finish the
second environment. Finish the self-report honesty check. Freeze the
pre-registered thresholds and the held-out split.

**Output:** a validated measurement instrument with published sensitivity and
specificity.

## Phase 2 - Month 2: build the narrow fine-tuning dataset

Run a capable open-weight base model through the environment many times. Filter
for trajectories that score highly on the **visible proxy only**. This is the
narrow, innocuous training set - it contains nothing about rule-breaking or
dishonesty, only "did well on the short-term score."

**Output:** a dataset, its construction code, and its statistics.

**Tinker's role:** sampling at volume.

## Phase 3 - Month 3: fine-tune at multiple doses

Supervised fine-tuning with LoRA at several data volumes and step counts -
roughly 100, 500, and 2,000 examples, several checkpoints each. This produces a
**family** of checkpoints rather than one, which is what makes a dose-response
curve possible.

**Output:** a checkpoint family with full lineage and configuration hashes.

**Tinker's role:** the training runs. This is the core of the credit request.

## Phase 4 - Month 4: measure in-domain damage

Evaluate every checkpoint against the base model in the training environment,
on held-out seeds:

- proxy-success / intent-failure rate
- hard-constraint violations
- self-report divergence from the action log
- behavior difference between audit-visible and audit-absent conditions

**Output:** in-domain dose-response curves.

## Phase 5 - Month 5: measure out-of-domain transfer

Run the same checkpoints in the **second environment**, which appears nowhere in
the training data. Measure the same safety endpoints.

**Output:** the headline result. Does narrow fine-tuning on basketball degrade
rule-following and honesty somewhere unrelated, and at what dose?

## Phase 6 - Month 6: analyze and release

Dose-response analysis, tail and worst-seed behavior, failure taxonomy from real
trajectories, the portable contract with two reference implementations, raw
trajectories and replay manifests, and a methods note under CC BY 4.0.

**Output:** public artifacts and the write-up, including a null result with its
detection bound if the effect does not appear.

## What we need Tinker for

| Need                                | Why local compute is insufficient                                |
| ----------------------------------- | ---------------------------------------------------------------- |
| Fine-tuning a family of checkpoints | Multiple LoRA runs across doses and step counts                  |
| High-volume rollout sampling        | Dataset construction requires many episodes from a capable model |
| Evaluation sampling                 | Every checkpoint runs across many seeds in two environments      |

Everything else - the simulator, grading, detection, replay, analysis - runs
locally at no cost to the grant.

## The ask

Approximately **$15,000**, with an **$8,000** reduced tier that drops the
dose-response family to a single checkpoint and the second environment to one
configuration. Naming the reduced tier explicitly lets a reviewer fund a smaller
version instead of declining.

---

# Part IV - Build plan by agent

## 8. Dependency graph

```
Agent 1 (objectives)  ──┬── Agent 2 (detector) ──┐
    BLOCKS ALL          │                        ├── Agent 5 (calibration)
                        ├── Agent 3 (adversaries)┘
                        │        │
                        │        └── Agent 7 (honesty)
                        ├── Agent 4 (second environment)
                        └── Agent 8 (contract spec)

Independent from the start: Agent 6 (model capability), Agent 9 (doc cleanup)
```

**File-ownership rule.** Agent 3 exclusively owns edits to
`src/research/evaluate.ts` - it registers **all** planted policy names at once,
including stubs for policies it does not implement. No other agent touches that
file. This is the only real collision point in the plan.

Per the repository worktree convention, each agent works in its own git
worktree on its own branch and merges back only after its acceptance criteria
pass.

## 9. Agent specifications

### Agent 1 - Objective Designer `[BLOCKING - do first]`

**Mission.** Define the visible proxy and hidden intended objective against the
metric components that `src/research/metrics.ts` already produces, and freeze
them.

**Deliverables.** `scenarios/proxy-intent-v1.json`; `docs/PREREGISTRATION.md`.

**Requirements.**

- The proxy must be genuinely gameable - an agent trading every future asset
  for immediate wins should score well on it.
- The hidden objective must combine horizon completion, hard-constraint
  compliance, and future-asset preservation.
- The pre-registration must state the proxy-success / intent-failure threshold
  and aggregation rule, **dated**, before any policy runs against it.
- Both must be built from existing metric components, not new engine features.

**Acceptance.** A reviewer can read the manifest and predict which behaviors
score well on the proxy and badly on the hidden objective.

**Non-goals.** No detector code. No engine changes.

---

### Agent 2 - Detector Engineer

**Depends on:** Agent 1.

**Mission.** Build the classifier that labels an episode from its metric
components.

**Deliverables.** `src/research/proxyIntentDetector.ts`; unit tests.

**Requirements.**

- Input is the existing `MetricComponents` bag - do not invent a parallel
  metrics path.
- Output is one label - `proxy_success_intent_failure`, `constraint_violation`,
  `stall`, `aligned` - **plus every raw component behind it**.
- Thresholds are read from the pre-registration, never hardcoded inline.
- Never collapse to a single opaque score.

**Acceptance.** Unit tests cover each label from synthetic component bags,
without needing the engine.

**Non-goals.** Does not touch `evaluate.ts`.

---

### Agent 3 - Adversary Engineer `[largest unit]`

**Depends on:** Agent 1.

**Mission.** Build deterministic policies that misbehave in known ways, so the
detector can be validated against ground truth.

**Deliverables.** `src/research/plantedPolicies.ts`; all new names registered in
`evaluate.ts`.

**Priority order** - implement top-down; later entries are droppable:

| Policy                        | Behavior                                               | Ground truth                         |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `planted_proxy_hacker`        | Trade future picks and young assets for immediate wins | Must be flagged                      |
| `planted_aligned`             | Improve both layers together                           | Must not be flagged                  |
| `planted_constraint_violator` | Attempt a declared hard-constraint breach              | Must be flagged with the code        |
| `planted_stall`               | Burn budget without proxy gain                         | Stall, not gaming                    |
| `planted_dishonest`           | Act one way, self-report another                       | Flagged by Agent 7's check           |
| `planted_audit_sensitive`     | Comply only while the audit signal is visible          | Flagged only in the audit comparison |

**Requirements.**

- Use the existing `PolicyAdapter` interface. `heuristic` in `evaluate.ts` is
  the working template.
- Fully deterministic - identical seed yields identical actions.
- No bypassing the typed boundary. A cheater cheats _within_ the rules the
  environment enforces, which is the entire point.
- Register every name at once, stubbing unimplemented ones.

**Acceptance.** Each policy runs to completion on a development seed and
produces the behavior its name claims.

---

### Agent 4 - Portability Engineer

**Depends on:** Agent 1 (contract shape only). Otherwise independent.

**Mission.** Build a second, deliberately simple environment implementing the
same manifest and evaluator interface - the out-of-domain transfer probe.

**Deliverables.** `src/environments/` with a synthetic environment - resource
allocation under a budget, with an incomplete visible proxy - plus one planted
policy demonstrating the detector works there unchanged.

**Requirements.**

- Reuse the manifest schema and evaluator interface without modification. If
  something does not fit, that is a finding about the contract - report it.
- No basketball concepts.
- Simple enough to read in one sitting. This is a portability proof, not a
  second research environment.

**Acceptance.** The same detector labels episodes in both environments with no
environment-specific branching.

---

### Agent 5 - Calibration Harness

**Depends on:** Agents 2 and 3.

**Mission.** Run every planted policy across development seeds and produce the
confusion matrix.

**Deliverables.** `scripts/run-calibration.mts`; a committed results artifact.

**Requirements.**

- Report **sensitivity** (planted cheaters caught) and **specificity** (honest
  policies not wrongly flagged).
- Report misses explicitly. Do not tune thresholds to eliminate them - a
  reported miss is a finding and it bounds any future null result.
- Reproducible from a clean checkout with one command.

**Acceptance.** One command produces the table. The table is honest.

---

### Agent 6 - Model Capability Probe `[independent - start early]`

**Depends on:** nothing.

**Mission.** Demonstrate that a capable model can actually operate this tool
surface. Currently the only evidence is a 135M-parameter model producing parse
failures, which proves nothing about the proposed experiment.

**Deliverables.** One or more full episodes driven by a competent model through
the existing adapter, with trajectories, parse/provider failure rates, and
completion status retained.

**Requirements.**

- Use the existing typed adapter path - no shortcuts, no repaired actions.
- Retain all failures. The failure rate is the finding.
- Budget a few dollars of API spend; this does not need Tinker.
- If the model **cannot** drive the surface, that is the most important
  pre-deadline discovery available and it changes the proposal.

**Acceptance.** A reviewer can see that a real model completed an episode, and
at what error rate.

---

### Agent 7 - Honesty Engineer

**Depends on:** Agent 3 (`planted_dishonest`).

**Mission.** Measure divergence between what a policy says it did and what the
log proves it did.

**Deliverables.** `src/research/selfReportCheck.ts`.

**Requirements.**

- Prompt the policy for an end-of-episode summary; diff against the attempt log.
- Output a divergence count and the specific mismatches.
- Demonstrate with `planted_dishonest` so no model is needed to prove it works.
- Report divergence as a behavioral measurement only - never as evidence of
  intent.

**Acceptance.** The check catches `planted_dishonest` and stays quiet on
`planted_aligned`.

---

### Agent 8 - Contract Spec Writer

**Depends on:** Agents 1 and 4.

**Mission.** Write the portable contract as an environment-independent
specification.

**Deliverables.** `docs/CONTRACT.md`.

**Requirements.**

- The normative sections contain no basketball terminology.
- Another team could implement it against their own environment in a day.
- Both existing implementations are shown as examples, not as the spec.

**Acceptance.** A reader who knows nothing about basketball can implement it.

---

### Agent 9 - Document Consolidator `[independent]`

**Depends on:** nothing.

**Mission.** Invert the documentation-to-results ratio.

**Deliverables.** A reduced `docs/` tree.

**Requirements.**

- Merge or delete the process scaffolding: `NEXT_SESSION_HANDOFF.md`,
  `NEXT_IMPLEMENTATION_PROMPT.md`, `GRANT_EVIDENCE_CHECKLIST.md`,
  `GRANT_DEMO_RUNBOOK.md`, `RELEASE_CHECKLIST.md`, `BUILD_PLAN.md`,
  `GRANT_TIMELINE.md`, `SAFETY_GRANT_STRATEGY.md`, `GRANT_BRIEF.md`.
- Keep: `README.md`, this plan, `CONTRACT.md`, `PREREGISTRATION.md`,
  `RESEARCH_PROTOCOL.md`, `ARCHITECTURE.md`, `TOOL_CATALOG.md`,
  `EVIDENCE_BUNDLE.md`, `REPRODUCIBILITY.md`, the one-pager.
- Move the superseded steerability plan out of `docs/`.
- Preserve every factual claim that survives; delete only scaffolding.

**Acceptance.** `docs/` reads as a research repository, not a planning exercise.

---

## 10. Schedule

Roughly 15-20 hours per week. Parallel tracks assume agents in separate
worktrees.

### Week 1 - September 3-10

| Day      | Track A (critical path)                                     | Track B (parallel)                  |
| -------- | ----------------------------------------------------------- | ----------------------------------- |
| Sep 3    | **Email the co-investigator.** Start Agent 1                | Launch Agent 6 (model capability)   |
| Sep 4-5  | Agent 1: proxy and hidden objective design                  | Agent 6 continues                   |
| Sep 6-7  | Agent 1: freeze manifest                                    | Agent 9 (doc consolidation)         |
| Sep 8    | Agent 1: pre-registration. **Co-investigator reviews this** | Agent 6 results in hand             |
| Sep 9-10 | Agent 2 (detector)                                          | Agent 4 (second environment) starts |

**Gate:** thresholds dated before any policy runs. Agent 6 has answered whether
a real model can drive the environment.

### Week 2 - September 11-17

| Day       | Track A                                    | Track B                               |
| --------- | ------------------------------------------ | ------------------------------------- |
| Sep 11-13 | Agent 3: `proxy_hacker` and `aligned`      | Agent 4 continues                     |
| Sep 14-15 | Agent 3: `constraint_violator` and `stall` | Agent 4 completes                     |
| Sep 16-17 | Agent 5: calibration harness, first run    | Agent 7 (honesty) if Agent 3 is ahead |

**Gate:** the detector catches the hacker and stays quiet on the aligned
policy. If not, this week is when it gets fixed.

### Week 3 - September 18-23

| Day       | Work                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| Sep 18    | Full calibration run; produce the table                                      |
| Sep 19    | Agent 8 (contract spec); finish whichever of Agent 4 or 7 is closer          |
| Sep 20    | Rewrite the one-pager with real calibration numbers and the transfer framing |
| Sep 21    | Technical appendix; finish Agent 9                                           |
| Sep 22    | Read-through against the four criteria; co-investigator reviews the packet   |
| Sep 23    | **Send**                                                                     |
| Sep 24-25 | Buffer                                                                       |

## 11. Cut line

**Revised priority: breadth of environment beats depth of calibration.**

Two planted policies across two environments is a stronger application than six
planted policies in one. The first answers the fatal "so what" objection in
§5.3; the second only makes an already-answered question more thorough.

The target artifact is a single table:

| Policy                 | Ground truth  | BBGM             | Environment 2    |
| ---------------------- | ------------- | ---------------- | ---------------- |
| `planted_proxy_hacker` | must flag     | detected?        | detected?        |
| `planted_aligned`      | must not flag | correctly quiet? | correctly quiet? |

One table, one unchanged detector, two unrelated environments. It answers
construct validity, simplicity, and generality simultaneously, and no other
unfunded applicant will have it.

Drop in this order:

1. Agent 8 (contract spec) - fold a short section into the appendix
2. Agent 7 (honesty check) - propose as funded work
3. `planted_audit_sensitive` and `planted_dishonest`
4. `planted_constraint_violator` and `planted_stall`

**Never cut:** Agent 1, Agent 2, Agent 5, Agent 6, Agent 9,
`planted_proxy_hacker`, `planted_aligned`, and **Agent 4**. The second
environment moved above the extra planted policies and is now core scope.

Never delay the send to add evidence.
