# Research protocol

This document describes how `bbgm-agent-mcp` is meant to be used as an
evaluation environment: how a scenario is specified, what gets measured,
how reward is derived from those measurements, what an agent should be
compared against, and how seeding and information exposure are controlled
so comparisons across agents stay fair.

**Status note.** `src/research/` implements the harness this document
describes: `scenario.ts` (manifest schema + loader), `evaluate.ts` (the
`research:evaluate` CLI entry point, driving a policy through `DomainService`
directly), `metrics.ts` (raw metric components), `objectives.ts` (scalar
reward + lexicographic/Pareto comparison), and `trajectory.ts`
(trajectory-log summarization). Two reference policies ship today, `no_op`
and a deterministic `heuristic`; an LLM-driven policy is not implemented
here (see "Baseline hooks"). The exact manifest field names are
`scenarioId`, `description`, `seedSet`, `userTeamId`, `startingSeason`,
`horizonSeasons`, `hardConstraints`, `softObjectives`, `allowedInformation`,
`allowedActions`, `maxSteps` (see `scenarioManifestSchema` in
`src/research/scenario.ts` for the authoritative shape) — this document
groups and explains them conceptually rather than 1:1 by name. **Known
gap:** `allowedInformation` and `allowedActions` are recorded on the
manifest and available to a policy, but the two shipped reference policies
do not currently enforce them (they don't call any view/tool outside the
default full set) — a policy implementation that needs an actual
information/action-restricted ablation must enforce that restriction
itself for now.

## Scenario manifests

A scenario manifest is the unit of reproducible comparison: it fully
determines the starting conditions and the rules of the game for every
agent evaluated against it. A manifest specifies:

| Field                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarioId`                | Stable identifier, passed as-is to `bbgm_create_episode`; groups trajectory logs and results                                                                                                                                                                                                                                                                                                                                                   |
| Initial conditions          | Either a league-generation config (`userTeamId`, `startingSeason`, and any engine-level league-gen settings) for a fresh league, or a specific starting snapshot/checkpoint to resume from, for scenarios that need a particular roster/standings situation rather than a fresh league                                                                                                                                                         |
| `seeds`                     | A fixed set of seeds (see "Seed policy" below) — a scenario is evaluated once per seed per agent, not once total                                                                                                                                                                                                                                                                                                                               |
| `userTeamId`                | The team the agent controls                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `horizonSeasons`            | How many seasons the episode runs before the harness calls `bbgm_end_episode`. The engine itself has no built-in season limit; the harness enforces the horizon by ending the episode once `TerminalMetrics.seasonsCompleted` reaches it                                                                                                                                                                                                       |
| `constraints.hard`          | Hard constraints, as `ConstraintDefinition[]` (`{ code, description }`) — passed straight through to `bbgm_create_episode`'s `constraints.hard`. Codes matching a built-in invariant (see `src/domain/invariants.ts`) are enforced with rollback; unmatched codes are recorded as declared but not mechanically enforced, since a generic harness can't invent scenario-specific legality logic                                                |
| `constraints.soft`          | Soft objectives, as `ObjectiveDefinition[]` (`{ code, description, weight, targetValue? }`) — becomes the `objectives` view and the basis for reward. Currently recognized codes with a built-in evaluator are `MAXIMIZE_WINS`, `MAXIMIZE_CAP_SPACE`, `MINIMIZE_ROSTER_CHURN`, and `PRESERVE_DRAFT_CAPITAL` (see `buildObjectivesFromSpec` in `src/domain/normalization.ts`); other codes currently report `0` and are a known extension point |
| Allowed information         | Which `bbgm_get_state` views the agent may call, and whether it sees the same `get_options` candidate set every baseline sees — see "Leakage controls" below                                                                                                                                                                                                                                                                                   |
| Allowed actions             | Which mutating tools are permitted for this scenario (e.g. a "no trades" ablation disallows `bbgm_execute_trade` at the harness level even though the tool remains legal at the protocol level)                                                                                                                                                                                                                                                |
| `maxToolCalls` / `maxSteps` | A budget on total tool calls (or mutating steps) for the episode, enforced by the harness, independent of `horizonSeasons` — lets you separate "ran out of season" from "ran out of budget" as failure modes                                                                                                                                                                                                                                   |

## Metrics

Metrics are grouped by what they measure. Every metric below is computed
from data already present in `EngineRawState`, the trajectory log, or
harness-level bookkeeping of tool calls — nothing here requires inventing
new engine fields, with the one noted exception (explicit championship
flag).

**On-court / competitive outcomes**

- Regular-season performance: `userTeam.won` / `userTeam.lost`, `standing`,
  rank and games-behind from the `standings` view, across seasons.
- Playoff performance: won/lost during the `playoffs` phase specifically
  (derivable from trajectory records' `revision`/phase transitions).
- Championship outcomes: as of this writing, `EngineRawState` has no
  explicit "won the championship" flag — this must currently be inferred
  from final playoff-phase standing/record, or by extending
  `EngineRawState`/`TeamSummary` with such a flag if a scenario needs it
  reported directly rather than inferred.

**Financial / roster health**

- Payroll and cap compliance: `userTeam.payroll` vs `salaryCap` vs
  `luxuryTaxThreshold`, and whether `CAP_COMPLIANCE` (hard when
  `hardCapActive`, soft otherwise — see `invariants.ts`) is satisfied over
  time.
- Hard-rule violation count: `TerminalMetrics.hardConstraintViolations`,
  incremented every time a mutation was rolled back for
  `INVARIANT_VIOLATION`; also derivable per-step from each trajectory
  record's `invariantResults`.
- Roster-age distribution: computed from `PlayerSummary.age` across the
  roster at any observed revision.

**Asset and value trajectory**

- Current player value: a scenario-defined function of `overall` /
  `potential` / contract terms per `PlayerSummary` (the domain layer
  intentionally does not bake in a single "player value" formula, so this
  is scenario/evaluation-harness-defined, analogous to `playerValue()` in
  `tests/fixtures/FakeSimulationEngine.ts`, which exists only as a test
  fixture, not a canonical valuation).
- Discounted future asset value: a scenario-defined discounting of the
  above over the remaining horizon, plus prospect/draft-pick value.
- Draft-capital value: derived from `ownedPicks` (`DraftPickSummary[]`) —
  count, round distribution, and years-out.
- Transaction count / churn: `TransactionRecord[]` counts by `type`
  (`trade`, `release`, `sign`, `draft`, `contract_extension`) over a window,
  and `TerminalMetrics.transactionCount` at episode end.
- Short-horizon gain vs. longer-horizon asset delta: the change in
  win-loss record over the next N games vs. the change in total roster +
  draft-capital value over the full remaining horizon, from the same
  action — the core signal for detecting myopic trading behavior.

**Constraint and recovery behavior**

- Constraint satisfaction over time: the `constraints` view's per-code
  `satisfied` flags, sampled across the episode, not just at the end.
- Recovery after adverse events: time-to-recovery (in steps or seasons) in
  a tracked metric (e.g. win rate, cap space) after an injury, a bad trade
  outcome, or an intentionally adverse scenario event.

**Agent behavior / efficiency**

- Invalid-action rate: fraction of tool calls that returned
  `VALIDATION_ERROR`, `ILLEGAL_ACTION`, or `INVALID_PHASE`.
- Stale-action / retry rate: fraction of mutating calls that returned
  `REVISION_CONFLICT`, and how often the same `idempotencyKey` was reused
  (a legitimate retry) vs. how often a fresh call followed a conflict (a
  re-plan).
- Tool-call efficiency: tool calls per unit of task progress (e.g. per
  season completed, per constraint satisfied) — a proxy for whether the
  agent is exploring state efficiently (narrow `get_state` views,
  `evaluate_trade` before `execute_trade`) or thrashing.

## Reward: components, not one collapsed number

The harness is expected to expose three things, never just the last one in
isolation:

1. **Raw metric components** — every metric above, unaggregated, per
   episode (and ideally per step, from the trajectory log), so any
   downstream analysis can recompute its own aggregate without rerunning
   episodes.
2. **A configurable scalar reward** — a documented, explicit weighted
   combination of a subset of the raw components (weights themselves
   should be part of the scenario manifest or a named reward config, not
   hardcoded), for use where a single training/selection signal is needed.
3. **A lexicographic or Pareto evaluation mode** — for scenarios where
   trading off a hard constraint against on-court performance is exactly
   the wrong thing to allow (e.g. "never breach the hard cap, and _among_
   cap-compliant agents, maximize wins" is a lexicographic ordering, not a
   weighted sum where a large win total could offset a cap breach).

A single undocumented collapsed reward number is explicitly not an
acceptable evaluation output on its own — it hides exactly the
myopia-vs-constraint-violation distinction this environment exists to
surface.

## Baseline hooks

Agents under evaluation should be compared against, at minimum:

- **No-op / advance-only** — never calls a mutating tool other than
  `bbgm_advance`; establishes the floor.
- **Basketball GM's own built-in AI**, where the engine exposes a
  comparable automated-GM behavior (roster/lineup/trade decisions the
  engine itself would make with no external agent) — meaningful only once
  the real-engine bridge surfaces that behavior; not available via the
  fake engine.
- **Deterministic heuristic GM** — a small, fully specified rule-based
  policy (e.g. "always start highest-`overall` five, sign the best
  available free agent under a cap threshold, never trade") implemented
  directly against `DomainService`, giving a reproducible, inspectable
  non-learned baseline.
- **Untrained open model** — an off-the-shelf LLM with no scenario-specific
  fine-tuning or few-shot examples beyond the tool descriptions themselves.
- **Prompted open model** — the same class of model, with scenario- or
  task-specific prompting/few-shot examples.
- **Fine-tuned model** — a model trained or fine-tuned specifically on this
  environment's trajectories or objective.
- **Frontier reference model** — a current strong general-purpose model, to
  contextualize where a specialized approach stands relative to raw
  capability.

## Seed policy

Each scenario manifest fixes a **set** of seeds, not a single seed. Every
agent under comparison is evaluated on the _same_ seed set for that
scenario, one episode per seed, and results are aggregated (not
cherry-picked from a single favorable seed) before comparing agents. This
is what makes "agent A beat agent B on scenario X" a meaningful statement
rather than an artifact of one lucky (or unlucky) random draw — the same
seed given the same engine commit and the same action sequence reproduces
the same state-hash sequence (see
[docs/REPRODUCIBILITY.md](REPRODUCIBILITY.md)), so a seed set also gives
you a fixed, replayable benchmark rather than a moving target.

## Leakage controls

- **Dry-run trade evaluation must not expose hidden information beyond
  real gameplay.** `bbgm_evaluate_trade` is intentionally read-only and
  side-effect-free so an agent can explore offers freely, but its output
  (`legal`, `acceptedByOtherTeam`, `payrollDelta`, `rosterSizeDelta`,
  `reasons`) must stay limited to what the same tool would reveal about any
  proposal — it must not become a channel for the opponent's private
  valuation function, scouting reports the user team hasn't scouted, or any
  other information a real GM negotiation wouldn't surface. Any harness
  extension to `evaluateTrade` should be checked against this before
  shipping.
- **Recommended ablations for isolating failure modes.** To tell a myopic
  agent apart from one that's simply breaking rules:
  - Run the same scenario with hard constraints relaxed to soft (or
    removed) and compare on-court/asset outcomes alone — isolates whether
    poor long-horizon asset value is a _strategy_ problem independent of
    constraint compliance.
  - Run with a shortened `horizonSeasons` vs. the full horizon on the same
    seed set — isolates whether an agent's apparent long-horizon planning
    is real, or whether it degrades once the horizon extends past whatever
    it was implicitly optimizing for.
  - Run with `bbgm_execute_trade` disallowed at the harness level (see
    "Allowed actions" above) — isolates roster-management and free-agency
    decisions from trade-driven asset shuffling.
