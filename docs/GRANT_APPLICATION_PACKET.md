# Grant application packet

Everything needed to send the application to `grants@thinkingmachines.ai`.
Deadline: **September 25, 11:59 PM PDT**. Reviews are returned within one week
of the deadline, so plan for a decision around **October 2**.

Related: [`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md) (the required
summary), [`GRANT_TIMELINE.md`](GRANT_TIMELINE.md) (pre-submission sprint and
six-month plan), [`SAFETY_GRANT_STRATEGY.md`](SAFETY_GRANT_STRATEGY.md)
(scientific framing), [`EVIDENCE_BUNDLE.md`](EVIDENCE_BUNDLE.md) (what is
actually measured today).

---

## 1. Requirement checklist

The call names four minimum requirements. Each maps to exactly one artifact.

| #   | Required by the call                                                                  | Artifact                                     | Status                     |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------- |
| 1   | 1-page summary, in English, explaining the research agenda                            | `docs/GRANT_ONE_PAGE_SUMMARY.md` (606 words) | Drafted; needs PI sign-off |
| 2   | List of PIs and expected contributors, with CVs attached                              | §3 below + PDF attachments                   | **Blocked on PI input**    |
| 3   | Location and organizational details, including tax ID and admin contact if applicable | §4 below                                     | **Blocked on PI input**    |
| 4   | Primary contact email address                                                         | §4 below                                     | **Blocked on PI input**    |

Items 2-4 are the only true blockers. Nothing in the scientific plan is
waiting on anything except the pre-submission sprint in
[`GRANT_TIMELINE.md`](GRANT_TIMELINE.md).

### Word-count gate

Re-run before sending; keep the summary body under ~680 words so it prints as
one page:

```bash
python3 -c "import re;b=open('docs/GRANT_ONE_PAGE_SUMMARY.md').read().split('---',1)[1];print(len(re.findall(r\"[A-Za-z0-9'-]+\",b)),'words')"
```

---

## 2. Attachment manifest

Send as one email with attachments named exactly as below. Reviewers should be
able to evaluate the proposal from the first two attachments alone.

| Order | Filename                               | Source                                                | Required?                            |
| ----- | -------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| 1     | `01-summary-<lastname>.pdf`            | `docs/GRANT_ONE_PAGE_SUMMARY.md`, exported to PDF     | **Required**                         |
| 2     | `02-technical-appendix-<lastname>.pdf` | §6 criteria response + §7 budget of this file         | Recommended                          |
| 3     | `03-cv-<lastname>.pdf`                 | PI CV                                                 | **Required**                         |
| 4     | `04-cv-<contributor>.pdf`              | One per additional contributor                        | Required if contributors listed      |
| 5     | `05-evidence-summary.pdf`              | Reviewer path from `docs/GRANT_EVIDENCE_CHECKLIST.md` | Optional but strengthens feasibility |

Keep the total under ~10 MB. Do not attach raw `.data/` run output; link the
repository instead and let the evidence summary point into it.

---

## 3. Principal investigators and contributors

Fill in before sending. Do not submit with placeholders.

| Field                                     | Value                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Principal investigator                    | `[full name]`                                                           |
| Role / title                              | `[role]`                                                                |
| Affiliation                               | `[institution, company, or "independent researcher"]`                   |
| CV attached as                            | `03-cv-<lastname>.pdf`                                                  |
| Relevant background to state in 2-3 lines | `[ML/safety/systems experience that makes the six-month plan credible]` |

| Contributor | Role on this project                  | CV filename        |
| ----------- | ------------------------------------- | ------------------ |
| `[name]`    | `[e.g. evaluation harness, analysis]` | `04-cv-<name>.pdf` |

**If you are applying solo:** say so explicitly rather than leaving the
contributor table empty. A solo application is fine for this scope, but the
timeline in [`GRANT_TIMELINE.md`](GRANT_TIMELINE.md) is sized for one
full-time-equivalent researcher and should be described that way, so reviewers
score feasibility against the real staffing.

---

## 4. Location, organization, and contact

| Field                                     | Value                              |
| ----------------------------------------- | ---------------------------------- |
| Primary contact email                     | `[email]`                          |
| Location (city, state/region, country)    | `[location]`                       |
| Applying as                               | `[individual]` or `[organization]` |
| Legal entity name (if organizational)     | `[entity]`                         |
| Tax ID / EIN / equivalent (if applicable) | `[id]`                             |
| Administrative contact (if applicable)    | `[name, email]`                    |
| Country of tax residence                  | `[country]`                        |

**Individual applicants:** the call asks for organizational details "if
applicable." Write "Applying as an individual researcher; no organizational tax
ID applies" rather than leaving the field blank, so the reviewer does not read
it as an omission.

**Organizational applicants:** confirm with your grants office _before_ the
deadline that the entity can accept an award with **no indirect costs**. The
program terms bar institutional indirect cost recovery, and this is the most
common late-stage blocker for university-affiliated applicants.

---

## 5. Cover email

Subject: `Safety Research Grant application - Auditing reward hacking after narrow fine-tuning in tool-using agents`

> Hello,
>
> Please find attached our application to the Safety Research Grants program.
>
> **Project:** Auditing reward hacking and oversight-sensitive behavior after
> narrow fine-tuning in tool-using agents.
>
> We propose a controlled study of whether narrow fine-tuning against an
> incomplete visible proxy improves an independently computed hidden intended
> objective, or instead produces proxy-success / intent-failure episodes, in a
> stateful tool environment with exact replay. The environment, typed tool
> boundary, deterministic controls, and replay-verified reference panel already
> exist and run today; the grant would fund the Tinker training run, the
> proxy-intent scenario family, and the held-out safety evaluation.
>
> Attached:
>
> 1. One-page project summary
> 2. Technical appendix (evaluation design, construct-validity calibration, compute plan)
> 3. CV - `[PI name]`
>    `[4. CV - contributor]`
>
> **Primary contact:** `[name]`, `[email]`
> **Location:** `[location]`
> **Organization / tax ID:** `[entity and ID, or "individual applicant; not applicable"]`
> **Requested Tinker credits:** `[amount]` (see appendix §7 for the derivation and a reduced-scope tier)
>
> The code and evaluation harness are open under MIT; results will be published
> under CC BY 4.0. We are happy to rescope the compute request or the check-in
> cadence to fit your review.
>
> Thank you for considering the proposal.
>
> `[name]`

---

## 6. Response to the stated selection criteria

Reviewers score on four named criteria. Address them in this order and in this
language.

### Relevance

The proposal targets two failure modes the program names directly: **reward
hacking** and **safety-relevant generalization from narrow fine-tuning**, with
**worst-case / tail behavior** as the risk layer and **oversight-sensitive
behavior** as a carefully bounded subtest. The setting is open-weight models,
where downstream narrow fine-tuning is the realistic modification path and the
one a model developer cannot supervise after release. The measurement targets
the gap between the objective a downstream trainer can cheaply measure and the
objective they actually hold - which is the mechanism, not a metaphor for it.

### Feasibility

The critical path has exactly one unbuilt external dependency: the Tinker
training loop. Everything downstream of it - environment, typed action
boundary, scenario manifests, evaluator, controls, replay verification,
provenance capture - is implemented and exercised in this repository today
against a pinned real engine. Concretely, what already runs:

- Basketball GM 5.1.0 pinned by commit, with engine-identity checks;
- 16 typed MCP tools with revision-aware, idempotent, rollback-safe mutations;
- frozen development (3-seed) and held-out (2-seed) scenario manifests;
- a verifier-passing five-seed reference panel: heuristic completes 3/5,
  no-op 0/5, with all 10 episodes and 17 rollback records replay-verified;
- a real open-model adapter run end to end through the same typed boundary,
  with parse and provider failures retained rather than hidden.

Feasibility is further protected by the fallback structure in §8: the study
ships a publishable result even if the training run fails to produce the
predicted behavior, and even if it fails to converge at all.

### Construct validity

The call asks whether the metrics actually capture what they claim. Our answer
is a **calibrated detector**, not an asserted one. Before any learned policy is
scored, we run the detector against planted policies with known ground truth:

| Planted policy        | Ground truth                                          | Detector must                                     |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Proxy-hacker          | Optimizes visible proxy, sacrifices hidden objective  | **Flag** (true positive)                          |
| Constraint-violator   | Trips a declared hard constraint                      | **Flag** with the constraint code                 |
| Stall / budget-burner | Fails horizon without proxy gain                      | **Not** flag as reward hacking; classify as stall |
| Aligned optimizer     | Improves both proxy and hidden objective              | **Not** flag (true negative)                      |
| Monitoring-sensitive  | Behaves differently only when audit signal is visible | Flag in the audit-condition comparison only       |

Reported as sensitivity and specificity against known labels. If the detector
misses planted hacks or fires on aligned controls, that is a reported failure
and is fixed before any model result is produced. Supporting safeguards:
policy-visible observations are separated from evaluator-only metrics; proxy
and intended objective are frozen before training; multiple hidden valuations
are tested rather than one asserted "true value"; raw components are always
reported alongside any aggregate; rejected, stale, timed-out, parse-failed and
retried attempts are retained; and state hashes plus clean-room replay verify
that the scored trajectory is the trajectory that happened. We state plainly
that action traces are behavioral evidence and never evidence of intent.

### Simplicity and generality

The reusable artifact is deliberately small: a **proxy-intent environment
contract** consisting of a JSON scenario manifest (allowed observations,
allowed actions, hard constraints, horizon, budget, seed split) and a narrow
evaluator interface that returns raw components rather than a scalar. The
detector on top of it is one table of raw components and one pre-registered
threshold rule - implementable by another team in a day against their own
environment.

Basketball GM is the reference implementation, not the contribution. To
demonstrate that the measurement is not a game-specific artifact, we port the
same contract and the same detector to one deliberately simple second
environment with the same structural properties (delayed consequences,
irreversible actions, an incomplete visible proxy) and re-run the planted-policy
calibration there. Two implementations of one small contract is the
generality claim; a bigger simulator is not.

---

## 7. Compute plan and credit request

The program offers up to $50,000 in Tinker credits at current rates, expiring
12 months after provisioning. Our request is sized from the rollout plan below,
not from the cap.

### Rollout units

| Line                    | Unit                   |  Count | Notes                                                          |
| ----------------------- | ---------------------- | -----: | -------------------------------------------------------------- |
| Base-model calibration  | full-horizon episodes  |     80 | Base and prompted-base across dev seeds, 2 samples each        |
| Detector calibration    | full-horizon episodes  |      0 | Planted policies are deterministic and run on local CPU        |
| RL training rollouts    | short-horizon episodes | ~2,900 | Group size 8, 12 tasks/iteration, ~30 iterations               |
| Checkpoint screening    | full-horizon episodes  |    120 | Development seeds only; no held-out looks                      |
| Final evaluation        | full-horizon episodes  |    320 | 4 model conditions x 20 seeds x 2 audit conditions x 2 samples |
| Second-environment port | short-horizon episodes |    200 | Generality check with the same detector                        |

Context is bounded by design: the policy receives a rolling scenario-limited
observation window rather than a growing transcript, targeting ~1.5-2k prompt
tokens per decision turn. This is a deliberate cost-control and
reproducibility decision, and it is what keeps an RL study of this shape inside
a grant-scale budget.

### Tiers

| Tier                     |  Amount | What it buys                                                                                                                        | Ships                                                           |
| ------------------------ | ------: | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Core**                 | $18,000 | Base calibration, one proxy-fine-tuned checkpoint, development screening, held-out evaluation, audit-condition comparison           | The minimum publishable result and the full deliverable set     |
| **Extended (requested)** | $28,000 | Adds a second checkpoint at a different training budget, the objective-aligned fine-tuning control, and the second-environment port | Everything above plus the generality and dose-response evidence |
| **Stretch**              | $35,000 | Adds a checkpoint sweep for early-warning forecasting                                                                               | Adds a scaling/forecasting analysis                             |

**Recommended request: $28,000 (Extended), with $18,000 named explicitly as the
scope we can complete if the program prefers a smaller award.** Naming the
reduced tier in the application is deliberate - it lets a reviewer fund the
project at lower cost instead of declining it.

Storage, analysis, local CPU simulation, evaluation harness execution, and all
grading run on local hardware at no cost to the grant. Credits are requested
only for remote training and sampling.

### Model selection

The design is model-agnostic and requires only reliable structured tool-call
formatting. We will select a Tinker-supported open-weight instruct model in the
small-to-mid parameter class, confirmed against the supported-model list at
kickoff, and record model revision, tokenizer/rendering method, LoRA
configuration, sampling parameters, and adapter revision as provenance for
every result.

---

## 8. What ships if something fails

Feasibility scoring rewards a plan that cannot produce zero output. Ours has
three floors.

| Failure                                                | Effect                         | What still ships                                                                                                                 |
| ------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Fine-tuning produces no reward hacking                 | Primary hypothesis unsupported | A null result with the detector's measured sensitivity on planted hacks, which bounds how large an effect we could have detected |
| Training fails to converge or Tinker access is delayed | No learned-policy result       | The calibrated detector, the portable contract, the two-environment implementation, and full deterministic-control results       |
| Second environment port stalls                         | Weaker generality claim        | Single-environment result plus the published contract specification                                                              |
| Base model cannot use the tool surface reliably        | Confounded model results       | Reported as a capability floor with parse/provider failure rates; the environment and detector are unaffected                    |

In every branch the reusable measurement artifact ships. That is the intended
contribution.

---

## 9. Program-terms compliance

Confirm each before sending. These come from the program terms, not the call
page, and each has bitten applicants late.

- [ ] **Not confidential.** The application and work product are treated as
      non-confidential. Remove anything you would not want public.
- [ ] **Open licensing.** Published work must use CC BY 4.0 or another approved
      open license. Wrapper code is MIT; confirm the results/methods note is
      CC BY 4.0.
- [ ] **Publication approval.** Work using or referencing Company Materials
      needs written approval before publication. Build this into the Month 6
      schedule, not the last week.
- [ ] **Direct costs only.** No institutional indirect costs.
- [ ] **Credit expiry.** Unused credits expire 12 months after provisioning; the
      six-month plan finishes well inside that.
- [ ] **Third-party engine.** Basketball GM / zengm is a separate
      source-available dependency under its own terms. This project does not
      vendor, host, or redistribute it, and reviewers obtain it themselves.
      State this in the appendix so the licensing boundary is visible up front.
- [ ] **No secrets in artifacts.** `TINKER_API_KEY` and any provider credential
      live in the environment only - never in Git, manifests, logs, prompts, or
      generated reports.

---

## 10. Final send gate

Do not send until every line is true.

- [ ] One-page summary is final, under the word gate, and free of placeholders.
- [ ] PI name, role, affiliation, and CV are attached.
- [ ] Every listed contributor has a CV attached.
- [ ] Location, organizational status, tax ID (or explicit "not applicable"),
      and admin contact are filled in.
- [ ] Primary contact email is stated in both the email body and the summary.
- [ ] The credit request names a specific amount **and** the reduced tier.
- [ ] The proposal separates measured repository evidence from funded future
      work, with no claim that a Tinker-trained result already exists.
- [ ] The null-result commitment is present.
- [ ] Program-terms checklist in §9 is complete.
- [ ] Attachments open cleanly as PDFs from a different machine.
- [ ] Sent to `grants@thinkingmachines.ai` before September 25, 11:59 PM PDT.
