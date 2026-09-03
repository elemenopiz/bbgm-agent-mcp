# Basketball GM functionality audit

This audit compares the MCP wrapper with the pinned upstream Basketball GM
checkout recorded in `bbgm-engine.lock.json`:

- upstream version: `5.1.0`
- upstream commit: `4ee432c5b9097ed978749a049fff5823711690dc`
- comparison source: `.cache/zengm/src/worker/api`, `.cache/zengm/src/worker/views`, the upstream play menu/actions, and the wrapper registrations/schemas under `src/tools/` and `src/domain/`

The goal is not UI parity. The MCP is a bounded research environment, so a
feature is valuable when it changes the decisions an agent can make, the
observations required to make those decisions, or the reproducibility of an
experiment.

## Executive assessment

The current MCP already exposes the core state-changing GM loop and the full
typed time-control surface:

1. inspect the user's state and any team's public roster;
2. evaluate and execute trades involving players and draft picks;
3. set the lineup, release players, negotiate contracts, and sign free agents;
4. make mandatory draft picks;
5. advance a seeded league with game/day/week/month/count controls or named
   milestones, checkpoint it, restore it, and replay its audit trail.

That is enough to demonstrate a real decision environment. It is not yet a
complete research surface for the most interesting Basketball GM planning
problems. The largest missing capabilities are trade discovery and rich
free-agency information—not the basic ability to perform a trade, sign a
player, or make a pick. The draft view now includes a complete current-owner
pick ledger, so an agent can discover opponent pick IDs without UI-specific
state.

## Parity matrix

| Upstream capability                                                                                                                                       | MCP status                                                                                              | Research impact                                                                                         | Recommendation                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Public roster inspection                                                                                                                                  | Exposed through `get_state(view="roster", teamId)`                                                      | Agents can identify trade assets                                                                        | Keep as-is; this was previously a major visibility gap                                    |
| Trade legality, payroll effects, and acceptance dry run                                                                                                   | Exposed through `bbgm_evaluate_trade`                                                                   | Supports deliberate proposal search                                                                     | Keep as the canonical trade path                                                          |
| Trade execution                                                                                                                                           | Exposed through `bbgm_execute_trade`                                                                    | Supports actual roster/asset planning                                                                   | Keep as the canonical mutation                                                            |
| Trading block / generated offers                                                                                                                          | Missing                                                                                                 | High: upstream can search partner teams and propose “make it work” offers from selected assets          | **P1 next feature**                                                                       |
| Trade counteroffer / `makeItWorkTrade`                                                                                                                    | Missing                                                                                                 | High: agents cannot ask the engine to construct a legal counterproposal                                 | **P1 next feature**, ideally alongside the trading-block read                             |
| Saved trades and saved trading-block state                                                                                                                | Missing                                                                                                 | Low for controlled experiments; useful for long interactive sessions                                    | P2; checkpoints cover reproducible persistence                                            |
| Free-agent list and basic signing                                                                                                                         | Exposed through `free_agents` and `bbgm_sign_free_agent`                                                | Supports roster filling                                                                                 | Keep as-is                                                                                |
| Contract negotiation mutation                                                                                                                             | Exposed through `bbgm_negotiate_contract`                                                               | Supports resigning and extensions                                                                       | Keep, but improve semantics below                                                         |
| Negotiation list, willingness, desired salary, contract options                                                                                           | Missing                                                                                                 | High: without these observations, an agent must guess contract terms                                    | **P1 next feature**                                                                       |
| Upcoming free agents                                                                                                                                      | Missing                                                                                                 | Medium/high: important for multi-season planning                                                        | P1 after negotiation details                                                              |
| Cancel negotiation / bulk resign                                                                                                                          | Missing                                                                                                 | Medium: convenience and a complete resigning workflow                                                   | P2 unless a scenario needs it                                                             |
| Draft prospects and user's owned picks                                                                                                                    | Exposed through `draft` and `bbgm_make_draft_pick`                                                      | Enough for a controlled draft-choice task                                                               | Keep as-is                                                                                |
| Full draft-pick ledger across teams, including outgoing picks                                                                                             | Exposed through the `draft` view as a bounded current-owner ledger, plus the user's `ownedPicks` subset | Agents can discover opponent pick IDs and preserve current/original ownership semantics                 | Keep; add projected pick/history fields only for a concrete scenario                      |
| Draft lottery, draft history, scouting, class regeneration/import                                                                                         | Missing                                                                                                 | Medium for scouting research; not required for the first grant experiment                               | P2; keep outside the minimal safe contract initially                                      |
| Basic pacing (`next_game`, `next_decision`, `days`, `games`, `week`, `month`, `one_pick`)                                                                 | Exposed through `bbgm_advance`; `days` and `games` require a bounded `count` of 1–30                    | Gives an agent both fine-grained and efficient control over the long horizon                            | Keep; a scenario may narrow the list when a study needs a fixed cadence                   |
| Phase and season pacing (`phase`, `season_end`)                                                                                                           | Exposed through `bbgm_advance`                                                                          | Supports controlled multi-season progression                                                            | Keep as-is                                                                                |
| All-Star, trade deadline, playoffs, playoff-round, play-in, and through-playoffs milestones                                                               | Exposed through `bbgm_advance`, using upstream play-menu calls with a bounded phase-step fallback       | Matches meaningful BBGM decision boundaries without exposing an unbounded simulator                     | Keep; test milestone behavior against the pinned real engine                              |
| Draft and offseason milestones (`until_draft`, `until_next_pick`, `until_resign_players`, `until_free_agency`, `until_preseason`, `until_regular_season`) | Exposed through `bbgm_advance`; pending user draft/resigning decisions remain explicit                  | Important for multi-season planning                                                                     | Keep; do not expose upstream `untilEnd` because it can auto-complete user draft decisions |
| Target a specific scheduled game (`simToGame`)                                                                                                            | Missing                                                                                                 | Medium: useful for counterfactual schedule experiments, not required for ordinary planning              | P2                                                                                        |
| Flat roster order / lineup                                                                                                                                | Exposed through `bbgm_set_lineup`                                                                       | Supports basic lineup decisions                                                                         | Keep as-is                                                                                |
| Position-specific depth charts, playing-time modifiers, auto-sort                                                                                         | Missing                                                                                                 | Medium: current lineup control is less expressive than the original game                                | P2; requires a richer typed roster model                                                  |
| Team finances and standings                                                                                                                               | Exposed                                                                                                 | Necessary context for planning                                                                          | Keep as-is                                                                                |
| Settings, budgets, injuries, team management, god-mode tools                                                                                              | Intentionally missing                                                                                   | Low for the initial agent benchmark; many are setup/editor operations rather than ordinary GM decisions | Do not add until a concrete scenario requires them                                        |
| Expansion, fantasy, multi-team, and custom league drafts                                                                                                  | Intentionally unsupported and fail closed                                                               | Low for the initial grant path; materially increases the compatibility surface                          | Preserve the explicit unsupported boundary                                                |
| Upstream automatic `untilEnd` draft completion                                                                                                            | Intentionally omitted                                                                                   | It could silently make a mandatory user draft decision, which would change the research task            | Preserve the omission; require `bbgm_make_draft_pick`                                     |

## What is actually blocking the grant story?

The wrapper's missing upstream features are not the primary grant blocker. A
reviewer can already see a real engine, an isolated episode, typed actions,
rollback/idempotency, and the machinery needed to produce reproducible
evidence. The original grant-facing evidence blockers have now been addressed
for the research preview: the real open-model adapter smoke is recorded, a
separate held-out control panel is verified, provenance is attested, and the
question and action surface are documented. The remaining blockers are
deliberately scientific rather than packaging gaps:

1. run an open model across the development and held-out horizons rather than
   only the bounded one-seed smoke;
2. add the Tinker rollout/training loop with token/log-probability/reward
   lineage and evaluate at least one trained checkpoint; and
3. expand the seed/scenario panel before making a strong generalization claim.

Trade-block discovery and richer negotiation observations would strengthen the
research question and make the environment more compelling, but they should
not be described as already available until their adapter methods are
implemented and real-engine tested. Likewise, the external-policy adapter
boundary is not evidence that a learned or Tinker-trained policy has been run:
the default registry keeps those policy names unavailable until a concrete
adapter is supplied.

## Recommended implementation order

### P0 — grant evidence (complete for the preview)

- use `scripts/run-open-model-eval.mts` with a concrete adapter module;
- add held-out seeds and report confidence intervals/effect sizes;
- keep the current no-op and heuristic artifacts as controls;
- retain the exact engine lock, wrapper revision, adapter metadata, model
  configuration, and source/artifact checksums in the evidence bundle;
- run `pnpm research:verify` for report/trajectory consistency and
  `pnpm research:replay` with the separately obtained pinned engine for
  state-hash verification.

The current v9 fixed panel, held-out control panel, v4 open-model smoke,
replay manifest, and source attestation satisfy this preview gate. They do not
constitute a trained-agent result.

### P1 — decision-surface completeness

- expose a bounded read-only trading-block offer search;
- expose negotiation details (willingness, desired contract, and legal offer
  options) without leaking hidden opponent valuations;
- add a typed counterproposal operation only after its upstream semantics are
  covered by real-engine tests.

### P2 — richer game fidelity

- position-specific depth charts and playing-time controls;
- target-specific schedule simulation;
- upcoming free-agent projections and negotiation cancellation;
- scouting/history views only for experiments that need them.

This ordering keeps the grant experiment focused while making the remaining
parity work explicit rather than implying that the MCP is a full clone of the
Basketball GM UI.

## Safety boundary for time control

`allowedAdvanceTargets` is a scenario control, not a strategic action that the
evaluated policy should be able to rewrite. Public MCP episodes expose the full
typed preset with a 300-step/2-season budget, including `week`, `month`, and
`one_pick`; a research manifest can narrow that preset to milestone-only or to
any other explicit subset. For a grant run, the host should load the manifest
and pass its policy into `runEvaluation`; the model should receive only the
resulting observation and typed actions.

This project is a benchmark for long-horizon organizational decision making,
not a five-minute timer thesis. Time-control restrictions should therefore be
justified by the study's decision cadence and evidence needs, not by an
unstated claim that coarse controls are unsupported.
