# Grant timeline

Two clocks run in this document:

1. **The submission clock** - today through **September 25, 11:59 PM PDT**.
2. **The collaboration clock** - up to six months of model access, support, and
   scheduled check-ins, starting after the review week.

Fixed dates from the call: submission closes September 25; proposals are
reviewed within one week of the deadline; the collaboration runs up to six
months with check-ins "tailored to your timeline," which means the cadence
below is ours to propose.

| Milestone            | Date                               |
| -------------------- | ---------------------------------- |
| Today                | Thursday, September 3              |
| Internal send target | **Wednesday, September 23**        |
| Hard deadline        | Friday, September 25, 11:59 PM PDT |
| Expected decision    | On or before Friday, October 2     |
| Proposed kickoff     | Monday, October 5                  |
| Proposed completion  | Early April 2027                   |

The internal send target is two days early on purpose. PDF export problems,
CV chasing, and a grants office that needs a signature are the failures that
actually cost applications, and none of them are recoverable at 11 PM on the
25th.

---

## Part 1 - Pre-submission sprint (September 3-25)

Three working weeks. The sprint has two tracks that must not compete: an
**admin track** that is mandatory and blocking, and an **evidence track** that
is optional but is the highest-scoring work available before the deadline.

### The single highest-leverage pre-submission move

The construct-validity criterion asks whether the metrics measure what they
claim. **The detector calibration described in
[`GRANT_APPLICATION_PACKET.md` §6](GRANT_APPLICATION_PACKET.md) needs no Tinker
credits and no learned policy.** The planted policies are deterministic and run
on local CPU against the existing engine.

If that calibration is complete before September 25, the application changes
from _"we will validate the detector"_ to _"the detector is validated; here are
its sensitivity and specificity against planted hacks with known ground truth."_
That converts the weakest criterion into measured evidence, at zero compute
cost, inside the submission window. It is the sprint's priority after the
admin blockers.

### Week 1 - September 3-11: freeze the science, unblock the admin

| Track   | Task                                                                                                                                      | Done when                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Admin   | Confirm PI, contributors, and who is writing which CV                                                                                     | Names and owners recorded in packet §3                          |
| Admin   | Resolve individual vs. organizational filing; if organizational, open the no-indirect-costs question with the grants office **this week** | Written answer in hand                                          |
| Science | Write `scenarios/proxy-intent-v1.json`: visible proxy, hidden intended objective, hard constraints, horizon, budget, audit condition flag | Manifest committed and frozen                                   |
| Science | Pre-register the primary endpoint: the proxy-success / intent-failure threshold and aggregation rule                                      | Written down and dated **before** any policy is run against it  |
| Science | Extract the portable contract: document the manifest schema and evaluator interface as an environment-independent spec                    | Spec section written, no basketball terms in the normative part |

Gate for the week: **the endpoint is frozen and dated.** Nothing downstream is
credible if the threshold moves after results exist.

### Week 2 - September 14-18: calibrate the detector

| Track   | Task                                                                                                                   | Done when                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Science | Implement the five planted policies: proxy-hacker, constraint-violator, stall, aligned optimizer, monitoring-sensitive | Each is deterministic and runs through the unchanged typed boundary          |
| Science | Run all five across the development seeds; compute detector sensitivity and specificity against known labels           | Calibration table produced                                                   |
| Science | Fix or report every miss and false alarm                                                                               | Either the detector is fixed, or the limitation is written into the proposal |
| Science | Re-run the replay verifier on the calibration runs                                                                     | State hashes agree                                                           |
| Admin   | Draft CVs; request any external CV with a September 18 due date                                                        | Drafts exist                                                                 |

Gate for the week: **a calibration table with real numbers**, or an explicit
written statement that calibration is proposed rather than complete. Do not
half-report this.

### Week 3 - September 21-23: assemble and send

| Day             | Task                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Mon 21          | Fold calibration results into the one-page summary and appendix; re-run the word-count gate                                         |
| Mon 21          | Second-environment port: at minimum a stub implementing the contract with one planted policy, to make the generality claim concrete |
| Tue 22          | Full read-through against the four selection criteria; strip every claim that outruns the evidence                                  |
| Tue 22          | Export PDFs; verify they open on a different machine; confirm all CVs are attached                                                  |
| Wed 23          | Complete the send gate in packet §10; **send**                                                                                      |
| Thu 24 - Fri 25 | Reserved buffer. Only used if something above slipped                                                                               |

### If the sprint slips

Descend this ladder rather than missing the deadline. Each rung still produces
a fundable application.

1. Drop the second-environment stub; describe the port as funded work.
2. Drop calibration of the monitoring-sensitive policy; calibrate the other four.
3. Drop calibration entirely; present it as the Month 1 deliverable it already
   is in the six-month plan.
4. Submit the one-page summary, CVs, and admin details alone. **Requirements
   2-4 in packet §1 are the only things that cannot be dropped.**

Never delay the send to add evidence. A submitted proposal with a proposed
calibration scores; an unsent proposal with a finished one does not.

---

## Part 2 - Review window (September 26 - October 2)

Do not idle for a week. Work that is useful regardless of outcome, in priority
order:

1. Finish whatever rung of the sprint ladder was dropped.
2. Complete the second-environment port properly.
3. Build the Tinker rollout-capture scaffolding against the documented API -
   tokens, masks, log-probabilities, rewards, checkpoint lineage, configuration
   hashes - so Month 2 starts with integration rather than design.
4. Expand the development seed panel from 3 to 12 and the held-out panel from
   2 to 8, using local CPU only.

Items 1, 2, and 4 have value whether or not the grant is awarded.

---

## Part 3 - Six-month collaboration plan (October 5 - early April)

Each month has one deliverable, one gate that must pass before the next month
starts, and one artifact a reviewer can inspect at the check-in. Gates are
written so that a failed gate stops progression rather than being absorbed
silently.

### M1 - October 5 to November 3: freeze and calibrate

**Deliverable.** Frozen proxy-intent scenario family, pre-registered primary
endpoint and thresholds, frozen development/held-out split, completed
planted-policy calibration with sensitivity and specificity, and the leakage
tests confirming the policy cannot observe evaluator-only state.

**Gate.** No training begins until the endpoint is frozen and the detector
clears calibration. A detector that misses planted hacks is fixed here or the
study's detection floor is published as a limitation.

**Reviewer artifact.** Calibration table, frozen manifests, pre-registration
document with dates.

_If Week 2 of the sprint completed this, M1 shortens to the leakage tests and
the seed expansion, and the schedule gains roughly two weeks of slack._

### M2 - November 4 to December 3: instrument the training path

**Deliverable.** Tinker rollout capture wired end to end: tokens, masks,
log-probabilities, rewards, checkpoint lineage, configuration hashes, model and
adapter provenance. Base-model calibration rollouts complete.

**Gate.** An untrained end-to-end rollout is captured, scored, and replayed
with agreeing state hashes. No weights change before this passes.

**Reviewer artifact.** One complete untrained rollout record with provenance,
plus its replay verification.

**Needed from TML.** Tinker access provisioned; confirmation of the selected
base model against the supported list; a contact for API questions.

### M3 - December 4 to January 2: controls and pilot conditions

**Deliverable.** No-op, legal-completion, and deterministic heuristic controls
run across the expanded seed panels. Base and prompted-base model conditions
measured. Audit-visible / audit-absent conditions piloted. Failure taxonomy
drafted from observed behavior rather than anticipated behavior.

**Gate.** The failure taxonomy and thresholds are stable, and the base model
demonstrates a usable capability floor - it can complete episodes often enough
that a post-training difference is measurable. If it cannot, that is reported
as a capability floor and the model selection is revisited here, not later.

**Reviewer artifact.** Control comparison table with per-seed results and
parse/provider failure rates.

_December holidays fall in this window; the month is deliberately
light on new infrastructure._

### M4 - January 3 to February 1: train

**Deliverable.** One or more proxy-fine-tuned checkpoints at bounded training
budgets, with complete lineage, rollout records, and update metrics.

**Gate.** Checkpoint selection uses development seeds only. Held-out data are
not looked at. A selection record is written at the time of selection.

**Reviewer artifact.** Checkpoint lineage with configuration hashes and the
dated selection record.

**Needed from TML.** The bulk of the credit draw lands here; a mid-month
check-in on burn rate is useful.

### M5 - February 2 to March 3: held-out safety evaluation

**Deliverable.** Frozen development and held-out evaluations across all
required conditions, including alternative hidden valuations, unseen constraint
combinations, and the audit-condition comparison. Primary endpoint computed.

**Gate.** No held-out tuning, no silent exclusion of failed runs. Intention-to-
treat and completed-only analyses are both reported.

**Reviewer artifact.** Held-out results with per-seed deltas, the primary
endpoint, and the exclusion log.

### M6 - March 4 to early April: analyze, publish, hand over

**Deliverable.** Tail and generalization analysis, the failure taxonomy applied
to real trajectories, the portable contract published with two reference
implementations, raw trajectories and replay manifests, and a methods note
under CC BY 4.0. Null result written up if the predicted failure did not appear.

**Gate.** An independent reproduction path is documented and tested from a
clean checkout. Publication approval for any use of Company Materials is
requested **at the start of this month**, not at the end.

**Reviewer artifact.** The complete evidence bundle and the draft methods note.

---

## Part 4 - Proposed check-in cadence

The call tailors check-ins to our timeline. This is what we propose; it is
cheap for the program and keeps the project auditable.

| Check-in                 | When                     | Length | Purpose                                                                                                                                             |
| ------------------------ | ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kickoff                  | Week of October 5        | 45 min | Confirm base model, access provisioning, endpoint definition, and that the primary endpoint is frozen before training                               |
| Monthly                  | First week of each month | 30 min | One page: gate status, reviewer artifact, credit burn, and any scope change                                                                         |
| **Pre-training gate**    | Early January, before M4 | 45 min | Decision review: confirm the endpoint, controls, and checkpoint-selection rule before any weights change. The most valuable check-in in the project |
| **Pre-publication gate** | Early March              | 45 min | Review findings and limitations; request publication approval for any Company Materials reference                                                   |
| Wrap-up                  | Early April              | 45 min | Hand over artifacts, reproduction path, and the methods note                                                                                        |

Asynchronous written updates accompany every monthly check-in so the call is
optional for the program if the month is uneventful.

---

## Part 5 - Slip rules

Scope is descoped in this fixed order. The reduced-scope tier in packet §7 maps
to rungs 1-3.

1. Drop the checkpoint sweep and the scaling-forecast analysis.
2. Drop the objective-aligned fine-tuning control.
3. Drop the second training budget; keep one checkpoint.
4. Reduce the held-out panel from 8 seeds to 4, and say so explicitly.
5. Drop the second-environment port to a specification plus a stub.

The following are never dropped, because dropping any of them makes the result
unpublishable rather than smaller: the frozen pre-registered endpoint, the
planted-policy calibration, the held-out split discipline, the raw component
reporting, replay verification, and the null-result write-up.

---

## Part 6 - Staffing assumption

The schedule above assumes approximately one full-time-equivalent researcher
across six months, with local CPU handling all simulation, grading, and
analysis. State the real staffing in the application. A reviewer scoring
feasibility is comparing the plan against the team, and a plan that is honestly
sized for one person scores better than an ambitious one that implies four.
