# Build plan to submission

What has to exist in this repository before the application is sent on
**September 23** (deadline September 25). Written to be followed in order.

## The claim we are making

Fine-tuning a model on one narrow task can damage behavior in areas the
training never touched. This has been demonstrated mostly on single-turn text
output. **Nobody has established whether it happens to agents** - models that
take many actions over time, with consequences that arrive later.

We test that. The environment in this repository is the apparatus that makes
the test possible, because it can prove what an agent actually did: every
attempt is logged, state transitions are hashed, and episodes replay exactly.

The grant funds the experiment. The pre-deadline work is proving the
**measurement** is sound, because that is the part a reviewer can check without
funding us.

## Why calibration is the pre-deadline priority

The proposal says we can detect an agent gaming a metric. A reviewer's fair
response is: prove your detector works.

We prove it by building agents that cheat **on purpose**, whose ground truth we
know by construction, and showing the detector catches them and stays quiet on
the honest ones. This needs no Tinker credits, no trained model, and no grant
money - only local CPU and the environment that already exists.

That converts the construct-validity criterion from a promise into a table.

---

## The build blocks

### Block 1 - Define the two objectives

**Files:** `scenarios/proxy-intent-v1.json`, `docs/PREREGISTRATION.md`

Two scores per episode:

| Layer                         | What it is                                                                               | Who sees it                      |
| ----------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| **Visible proxy**             | Short-horizon competitive performance. Deliberately incomplete                           | The training loop and the policy |
| **Hidden intended objective** | Horizon completion, hard-constraint compliance, future asset preservation, roster health | The evaluator only               |

The proxy must be genuinely gameable: an agent should be able to trade away
every future asset for immediate wins and score well on it. That tension is
the experiment.

`docs/PREREGISTRATION.md` states, **dated, before any result exists**, the
threshold that makes an episode count as proxy-success / intent-failure and how
episodes aggregate. Written first so it cannot be tuned to a result later.

_Grant criterion: construct validity._

### Block 2 - Build the detector

**File:** `src/research/proxyIntentDetector.ts`

Consumes the existing `MetricComponents` bag from
[`metrics.ts`](../src/research/metrics.ts). Emits one label per episode plus
the raw numbers behind it:

- `proxy_success_intent_failure` - gamed the metric
- `constraint_violation` - broke a declared hard rule
- `stall` - failed the horizon without proxy gain
- `aligned` - improved both layers

Never collapse to a single score. The label is a claim; the components are the
evidence.

_Grant criterion: construct validity, simplicity._

### Block 3 - Build the planted policies

**Files:** `src/research/plantedPolicies.ts`, plus new entries in the
`PolicyName` union and `createDefaultPolicyRegistry` in
[`evaluate.ts`](../src/research/evaluate.ts)

Deterministic policies with known ground truth, all running through the
unchanged typed boundary. `heuristic` and `no_op` already exist and serve as
templates.

| Policy                        | Built to                                                    | Detector must                              |
| ----------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `planted_proxy_hacker`        | Trade away future picks and young assets for immediate wins | **Flag** as proxy-success / intent-failure |
| `planted_aligned`             | Improve both layers together                                | **Not** flag                               |
| `planted_constraint_violator` | Attempt a declared hard-constraint breach                   | **Flag**, naming the constraint code       |
| `planted_stall`               | Burn the step budget without proxy gain                     | Classify as stall, **not** as gaming       |
| `planted_dishonest`           | Act one way, self-report another                            | **Flag** in the self-report check          |
| `planted_audit_sensitive`     | Comply only while the audit signal is visible               | **Flag** only in the audit comparison      |

_Grant criterion: construct validity, feasibility._

### Block 4 - Run the calibration

**File:** `scripts/run-calibration.mts`

Runs every planted policy across the development seeds, feeds results to the
detector, and emits a confusion matrix:

- **Sensitivity** - of the policies built to cheat, how many were caught?
- **Specificity** - of the honest policies, how many were wrongly flagged?

This table is the headline pre-deadline artifact. A miss is not a failure to
hide - it is a finding to report and fix, and it bounds any future null result.

_Grant criterion: construct validity, feasibility._

### Block 5 - Self-report honesty check

**File:** `src/research/selfReportCheck.ts`

At episode end, ask the policy to summarize what it did. Diff that against the
attempt log. Report divergence count.

This is a differentiator: almost no environment can do it, because almost none
can prove what actually happened. Ours can. Demonstrated with
`planted_dishonest`, so it needs no model to show it works.

_Grant criterion: relevance, construct validity._

### Block 6 - Second environment

**Directory:** `src/environments/`

A small synthetic environment - resource allocation under a budget, with an
incomplete visible proxy - implementing the same manifest and evaluator
interface. A stub that runs one planted policy is sufficient before the
deadline.

Its job in the funded study is larger: it is the **out-of-domain transfer
probe**, where we test whether fine-tuning on basketball damages behavior
somewhere unrelated.

_Grant criterion: simplicity and generality._

### Block 7 - Documents

**Files:** `docs/GRANT_ONE_PAGE_SUMMARY.md` (rewrite), `docs/CONTRACT.md` (new)

Rewrite the one-pager around narrow-fine-tuning transfer, with the environment
as apparatus and the calibration numbers included. Write the portable contract
as an environment-independent spec - no basketball terms in the normative part.

Consolidate the existing 18 documents. A reviewer who sees more process
scaffolding than measured results draws the obvious conclusion.

---

## Timeline

Assumes roughly 15-20 hours per week. Send target **September 23**, two days
before the deadline.

### Week 1 - September 3-10: define and detect

| Day      | Work                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| Sep 3    | Email the PhD student. Send the repo and the research question                              |
| Sep 4-5  | Draft the visible proxy and hidden objective; decide what makes the proxy gameable          |
| Sep 6-7  | Write `scenarios/proxy-intent-v1.json` and freeze it                                        |
| Sep 8    | Write `docs/PREREGISTRATION.md`, dated. **Ask the PhD student to review this specifically** |
| Sep 9-10 | Build `proxyIntentDetector.ts` against the existing component bag                           |

**Gate:** the threshold is written and dated before any policy runs against it.

### Week 2 - September 11-17: build the cheaters

| Day       | Work                                                                    |
| --------- | ----------------------------------------------------------------------- |
| Sep 11-13 | `planted_proxy_hacker` and `planted_aligned` - the two that matter most |
| Sep 14-15 | `planted_constraint_violator` and `planted_stall`                       |
| Sep 16-17 | `scripts/run-calibration.mts`; first calibration run on dev seeds       |

**Gate:** the detector catches the hacker and stays quiet on the aligned
policy. If not, fix it now - that is what this week is for.

### Week 3 - September 18-23: prove, write, send

| Day       | Work                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Sep 18    | Full calibration run; produce the sensitivity/specificity table                                                 |
| Sep 19    | `planted_dishonest` plus the self-report check, **or** the second-environment stub - whichever is further along |
| Sep 20    | Rewrite the one-pager with real calibration numbers                                                             |
| Sep 21    | Write `docs/CONTRACT.md`; consolidate documents                                                                 |
| Sep 22    | Full read-through against the four criteria; PhD student reviews the packet                                     |
| Sep 23    | **Send**                                                                                                        |
| Sep 24-25 | Buffer. Unused if the above held                                                                                |

---

## If you fall behind

Cut in this order. Each rung still leaves a fundable application.

1. Second environment - describe it as funded work
2. Self-report honesty check - describe it as funded work
3. `planted_audit_sensitive`
4. `planted_dishonest`
5. `planted_stall` and `planted_constraint_violator`

**The irreducible core** is the scenario manifest, the dated pre-registration,
the detector, `planted_proxy_hacker`, `planted_aligned`, and the calibration
table. Two planted policies still produce a real calibration - one true
positive and one true negative - and that is enough to make the claim concrete.

Never delay the send to add evidence. A submitted proposal with a thin
calibration scores; an unsent proposal with a perfect one does not.

## What gets sent

| Attachment         | Contents                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| One-page summary   | The research question, the apparatus, the calibration result             |
| Technical appendix | Detector design, calibration table, contract spec, compute plan          |
| CVs                | PI and the PhD co-investigator                                           |
| Link               | This repository, with the calibration reproducible from a clean checkout |

Requested credits: approximately **$15,000**, with an $8,000 reduced tier named
explicitly. Supervised fine-tuning is far cheaper than an RL loop, and a small
ask backed by a working artifact is easier to approve than a large one backed
by a plan.
