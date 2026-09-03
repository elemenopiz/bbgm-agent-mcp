# Information audit: what BBGM surfaces vs what the agent sees

Method: compared the wrapper's `PlayerSummary` / view types against zengm's own
worker views (`src/worker/views/`, 109 of them) and the live UI. The benchmark
is deliberately **what a human GM sees in the game**, not what we imagine an
agent needs.

## 1. Player level

BBGM's own roster view (`worker/views/roster.ts`) requests these per player.
Bold rows are absent from the wrapper entirely.

| Field                                          | What it is                                                        | Exposed?                       |
| ---------------------------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| pid, firstName/lastName, age, pos              | identity                                                          | yes                            |
| ovr, pot                                       | current / peak ability                                            | yes                            |
| contract (amount + expiry)                     | current deal                                                      | partial - single year only     |
| injury                                         | availability                                                      | partial - games remaining only |
| rosterOrder                                    | lineup slot                                                       | yes                            |
| **dovr, dpot**                                 | **year-over-year change in ovr/pot**                              | **no**                         |
| **mood**                                       | **willingness to sign/re-sign, and the price they would accept**  | **no**                         |
| **value**                                      | **BBGM's own composite player valuation**                         | **no**                         |
| **untradable**                                 | **whether the player can be traded at all**                       | **no**                         |
| **skills**                                     | **tags: athlete, ball-handler, defensive-perimeter, passer, ...** | **no**                         |
| **ovrs**                                       | **overall rating by position - positional fit**                   | **no**                         |
| **ptModifier**                                 | **playing-time lever the human GM controls**                      | **no**                         |
| **yearsWithTeam, cashOwed, latestTransaction** | **tenure and financial exposure**                                 | **no**                         |
| **awards, hof**                                | **realized recognition**                                          | **no**                         |
| **gp, min, pts, trb, ast, per**                | **actual production**                                             | **no**                         |

The player detail page adds, per season and career:

- **15 individual ratings**: hgt str spd jmp end ins dnk ft 2pt 3pt oiq diq drb pss reb
- **26 per-game stats**, plus shot-location splits (at-rim / low-post / mid-range / 3PT)
- **advanced**: PER EWA TS% 3PAr FTr ORB% DRB% TRB% AST% STL% BLK% TOV% USG%
  +/- On-Off ORtg DRtg **OWS DWS WS WS/48** OBPM DBPM BPM
- **game highs** per stat, **full multi-year salary schedule**, statistical feats,
  injury and transaction history

**Ratings are stored per season**, so a development curve is directly readable.
An observed player ran ovr 55 -> 52 -> 60 -> 61 -> 69 against a flat potential of 76. That curve is the future-value signal the asset formula tried and failed to
approximate. `dovr`/`dpot` expose the same thing as a single delta.

## 2. Team and league level

| Surface                                                        | Exposed?                 |
| -------------------------------------------------------------- | ------------------------ |
| Standings, schedule, finances (payroll, cap, luxury tax)       | yes                      |
| minContract / maxContract                                      | yes - added this session |
| Team strategy (rebuilding vs contending), `keepRosterSorted`   | no                       |
| Profit, revenue, expenses, budget levers                       | no                       |
| Depth chart                                                    | no                       |
| Power rankings, league leaders, team/player stat distributions | no                       |
| Season preview, news feed, GM history                          | no                       |

## 3. Interaction surfaces with no wrapper equivalent

These are things a human GM _does_, not just reads:

| BBGM feature             | What it enables                                                                  |
| ------------------------ | -------------------------------------------------------------------------------- |
| **Trading Block**        | Advertise players/picks and receive AI offers, rather than guessing at proposals |
| **Trade Proposals**      | AI-initiated offers arriving unprompted                                          |
| **Negotiation List**     | Who is actually open to negotiating right now                                    |
| **Upcoming Free Agents** | Forward visibility of expiring contracts                                         |
| **Watch List / Notes**   | Persistent private annotations across turns                                      |
| **Compare Players**      | Side-by-side evaluation                                                          |
| **Game Log**             | What actually happened game to game                                              |

The trade-feasibility probe concluded the AI rejects most offers while never
touching Trading Block or Trade Proposals - i.e. it measured cold-proposal
acceptance, not BBGM's actual trade mechanism.

## 4. How to adapt this for an agent

Dumping everything every turn is wrong: prompt cost scales with the roster and
most of it is irrelevant to the current decision. Four principles:

**Mirror BBGM's own view boundaries.** They are already curated for
decision-making by fifteen years of play. Do not invent a new information
architecture; expose theirs.

**Progressive disclosure.** A compact roster line by default
(`pid, name, age, pos, ovr, pot, dovr, dpot, contract, injury, mood.willing`),
with a `get_player` tool returning the full detail page for one player when the
agent wants to dig. This is how a human uses the UI - scan the roster, click
into one player.

**Query instead of paginate.** 150 free agents over three pages is three round
trips to find minimum-salary options. Add filter/sort parameters
(`position`, `maxSalary`, `minOvr`, `sortBy`) rather than forcing blind paging.

**Keep evaluator-only data separate.** Exposing WS/VORP to the policy is fine
and desirable - it cannot see _future_ seasons' values, which is what the hidden
objective is computed from. The separation is by time, not by field.

### Proposed surface changes

| Priority | Change                                                                           | Unblocks                                                      |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1        | `mood.willing` + mood-adjusted asking price on players                           | Signing without brute force; the F6 deadlock                  |
| 2        | `dovr`/`dpot`, `skills`, `ovrs`, `value`, `untradable` on the roster line        | Real player evaluation                                        |
| 3        | Per-season ratings + advanced stats (WS, WS/48, VORP, BPM, PER) via `get_player` | Model reasoning **and** the realized-outcome hidden objective |
| 4        | Filter/sort on free agents and rosters                                           | Removes blind pagination                                      |
| 5        | Trading Block + Trade Proposals views and actions                                | Real trade mechanism, not cold proposals                      |
| 6        | Upcoming free agents, depth chart, power rankings, leaders                       | Planning context                                              |

## 5. Architectural finding: use zengm's own views

**The wrapper does not reimplement the simulation** - `.cache/zengm` is the real
cloned engine and it runs the real BBGM. But the _data layer_ is hand-rolled:
`adapter.ts` reads raw IndexedDB (`idb.cache.players.indexGetAll`) and
hand-maps fields into `PlayerSummary`, while zengm ships 109 curated worker
views that its own UI renders from.

Those views are directly importable. `build-engine-bridge.ts` copies
`entry.ts` **into** `<BBGM_SOURCE_DIR>/.mcp-bridge/` and bundles it there with
zengm's own rolldown, so `import("../src/worker/views/index.ts")` resolves.

Verified by spike (`zengmView` passthrough in `engine-bridge/entry.ts`):

```
views.roster({tid:0, season:2026, playoffs:"regularSeason"})
-> ratings: {ovr, pot, dovr, dpot, skills:["3","B","Di","Dp","Po","Ps","V"], pos}
   mood:    {components{...10 factors}, traits, probWilling:0.465,
             willing:false, contractAmount}
   value:   65.81      untradable: false
   stats:   {gp, min, pts, trb, ast, per, yearsWithTeam, jerseyNumber}
   + draft, born, contract, cashOwed, ptModifier, watch, hof, awards, canRelease
   view-level: maxRosterSize, numPlayersOnCourt, payroll, luxuryTaxAmount
```

Every gap in sections 1-3 above arrives in that single call. Other views
confirmed working on the first attempt: `tradingBlock`, `tradeProposals`,
`upcomingFreeAgents`, `powerRankings`, `leaders`. (`depth` returns "Not
implemented" - it is a football/hockey concept.)

### What the typed layer is still for

Views are not a drop-in replacement for the wrapper. They return `any`-typed,
UI-shaped payloads. The typed boundary still owns:

- stable schemas, so state hashing and replay stay reproducible;
- scenario-controlled information gating (`allowedInformation`);
- deterministic ordering and normalization; and
- separation of policy-visible data from evaluator-only data.

The change is to the **source**, not the contract: normalize from zengm's
curated views instead of hand-picking fields out of IndexedDB. That shrinks
the adapter, removes drift against upstream, and delivers the entire section-4
priority list at once.

## 6. Bug found during this audit

`src/domain/invariants.ts` hardcodes `ROSTER_MIN = 10` / `ROSTER_MAX = 15`.
zengm reads these from game attributes (`minRosterSize` / `maxRosterSize`),
which are configurable per league and differ by sport (e.g. 24-26, 40-55). The
values happen to match the basketball default, so the constraint is correct
today and would silently enforce wrong bounds on any custom league. Read them
from the engine instead - the roster view already returns `maxRosterSize`.
