/**
 * Documented notes and small guards about how faithfully adapter.ts's calls
 * into the pinned zengm commit (see bbgm-engine.lock.json) match our domain
 * model. Read this after bumping the pinned commit, and before trusting any
 * of the lower-confidence areas listed below in a decision-critical context.
 *
 * Confidence levels:
 *  - "high": Directly confirmed against the pinned commit's source (exact
 *    function found, signature read, call sites cross-checked against how
 *    zengm's own UI/api layer calls it).
 *  - "medium": Composed from confirmed real building blocks, but the exact
 *    composition (this adapter's, not zengm's own) is not independently
 *    exercised by any upstream test we read.
 *  - "low": Best-effort; the real operation could not be confidently mapped
 *    to a single zengm call, so adapter.ts approximates it, and the
 *    approximation is a simplification of real zengm behavior.
 */

export type IncompatibilityNote = {
  area: string;
  confidence: "high" | "medium" | "low";
  note: string;
};

export const KNOWN_INCOMPATIBILITIES: IncompatibilityNote[] = [
  {
    area: "toUI / cross-thread UI calls (bootstrap.ts: NODE_ENV)",
    confidence: "high",
    note:
      "Confirmed against a real run of the pinned checkout, not theoretical: with " +
      'process.env.NODE_ENV="production", core.league.createStream(...) (the real call create() ' +
      'makes) hangs forever partway through, at its "Finalizing..." step, inside an ' +
      'await toUI("resetLeague", []) call. toUI() (src/worker/util/toUI.ts) sends a message over ' +
      "a promise-worker-bi RPC channel to a companion UI thread and awaits its reply; in the real " +
      "browser/Electron build that UI thread exists and replies, but this headless worker has none, " +
      "so the promise never resolves and nothing (not even the 30s timeout inside idb.cache's own " +
      "_waitForStatus) rescues it. zengm's own source already guards this and several similar " +
      "call sites (updatePlayMenu.ts, updateMeta.ts, loadNames.ts, defaultCountries.ts) with " +
      '`if (process.env.NODE_ENV === "test") return ...` short-circuits -- exactly the escape hatch ' +
      "its own test suite relies on to run worker code without a real UI. bootstrap.ts therefore " +
      'sets NODE_ENV="test" (not "production"), reusing that upstream-sanctioned bypass rather than ' +
      "reimplementing a fake UI-thread RPC responder. TRADE-OFF: this also makes loadNames.ts use " +
      "zengm's own dummy name tables ({first: {FirstName: 1}, last: {LastName: 1}}) instead of " +
      "real generated names, so every randomly-created player in this adapter's leagues is named " +
      '"FirstName LastName" rather than a realistic name -- confirmed in a real create() run. This ' +
      "does not affect SimulationEngine correctness (PlayerSummary.name is still a valid, unique-ish " +
      "display string) but does reduce realism. A more surgical fix (a real, minimal postMessage " +
      "responder for the promise-worker-bi protocol, keeping NODE_ENV=production) is possible but " +
      "was judged out of scope for this pass; flagged for a follow-up.",
  },
  {
    area: 'g.get("day") (adapter.ts: getRawState)',
    confidence: "high",
    note:
      'Confirmed against a real run: g.get("day") THROWS ("Attempt to get g.day while it is not ' +
      'already set", src/worker/util/g.ts) rather than returning undefined when the "day" game ' +
      "attribute has never been set, which is the case for every episode until its first " +
      "day-by-day advance() call. EngineRawState.day is optional for exactly this reason; " +
      "getRawState() catches this specific throw and omits the field rather than letting it fail " +
      "the whole call.",
  },
  {
    area: "events.text is optional (mappings.ts: mapTransactionRecord)",
    confidence: "high",
    note:
      "Confirmed against a real run: the first trade/sign event in a real league's event log " +
      "crashed getRawState() with \"Cannot read properties of undefined (reading 'replaceAll')\". " +
      "Cross-checked against EventBBGMWithoutKey in common/types.ts: `text` is only mandatory for " +
      'the generic/legacy event shape -- modern "trade"/"freeAgent"/"reSigned" events carry no ' +
      '`text` field at all ("Only legacy will have text"). mapTransactionRecord now synthesizes a ' +
      "plain description from the structured pids/tids fields when text is absent, instead of " +
      "assuming it exists.",
  },
  {
    area: "api.main nesting (adapter.ts: ZengmModules.api)",
    confidence: "high",
    note:
      'Confirmed against a real run: a real makeDraftPick() call failed with "api.draftUser is not ' +
      'a function". Only actions/eightyTwoZeroDraft/exhibitionGame/leagueFileUpload/playMenu/' +
      "toolsMenu/undoLog are top-level on the real `api` default export " +
      "(src/worker/api/index.ts); every other function this adapter calls -- releasePlayer, " +
      "reorderRosterDrag, draftUser, acceptContractNegotiation, createTrade, proposeTrade -- is " +
      "nested one level deeper under `api.main.*`. All six call sites, and the ZengmModules.api " +
      "type, were fixed to go through `api.main.*` after this was caught by an actual run.",
  },
  {
    area: "Phase mapping (mappings.ts: phaseFromZengm)",
    confidence: "high",
    note:
      "zengm's EXPANSION_DRAFT and FANTASY_DRAFT phases have no domain Phase equivalent and " +
      "throw if encountered. CreateEpisodeInput never starts an expansion or fantasy draft, so " +
      "this is expected to be unreachable in normal use; it would only trigger if something else " +
      "(e.g. a hand-edited imported snapshot) put the league into one of those phases.",
  },
  {
    area: "PlayerSummary.role",
    confidence: "low",
    note:
      "zengm has no native starter/rotation/bench/inactive enum. mappings.ts derives it from " +
      "rosterOrder (0-4 starter, 5-7 rotation, 8+ bench) and injury status (any active injury -> " +
      "inactive, overriding roster position). This mirrors typical zengm UI conventions but is " +
      "this adapter's own heuristic.",
  },
  {
    area: "DraftPickSummary.round",
    confidence: "medium",
    note:
      "Domain model types round as 1 | 2. zengm's DraftPick.round is a plain number and a custom " +
      "league could have more rounds. Exact for the standard 2-round configuration " +
      "CreateEpisodeInput always produces; any round > 1 is clamped to 2.",
  },
  {
    area: "DraftPickSummary.protection",
    confidence: "low",
    note:
      "Sourced from zengm's free-text `note` field on the draft pick record, which upstream uses " +
      "for arbitrary annotations (including, but not limited to, protection terms) rather than a " +
      "structured protection type. Passed through as-is.",
  },
  {
    area: "ProspectSummary.scoutedOverall / scoutedPotential",
    confidence: "medium",
    note:
      'Uses the prospect\'s raw ratings.ovr/pot. Real zengm applies a scouting-accuracy "fuzz" to ' +
      "ratings surfaced to the user for players who haven't proven themselves, which is not " +
      "replicated here -- these are the true underlying ratings, not what a human GM would see " +
      "scouted through zengm's own UI.",
  },
  {
    area: "TransactionRecord.day",
    confidence: "low",
    note:
      "zengm's `events` object store (idb.cache.events) records `season` per event but not a " +
      "day-of-season. mappings.ts defaults `day` to 0 for every transaction. There is no zengm " +
      "data source this adapter could read from instead without adding per-event day tracking " +
      "upstream does not do.",
  },
  {
    area: "setLineup",
    confidence: "high",
    note:
      "Implemented via the real api.main.reorderRosterDrag(sortedPids) function (src/worker/api/index.ts), " +
      "the same function zengm's own roster drag-and-drop UI calls. It writes each player's " +
      "rosterOrder field directly and disables the team's keepRosterSorted auto-sort flag, " +
      "exactly matching manual reordering through the real UI.",
  },
  {
    area: "releasePlayer",
    confidence: "high",
    note:
      "Implemented via the real api.main.releasePlayer({ pids }) function, the same one the roster " +
      'page\'s "Release" button calls (ownership check, justDrafted salary-forgiveness handling, ' +
      "and free-agent contract-demand renormalization all included).",
  },
  {
    area: "makeDraftPick",
    confidence: "high",
    note:
      "Implemented via the real api.main.draftUser(pid, conditions) function, the same one the draft " +
      "page calls when the user clicks a prospect. It verifies the current pick actually belongs " +
      "to the user's team before drafting.",
  },
  {
    area: "signFreeAgent",
    confidence: "high",
    note:
      "Implemented via the real core.contractNegotiation.create(pid, resigning=false, tid) to open " +
      "a negotiation, then the real api.main.acceptContractNegotiation({pid, amount, exp}) to finalize " +
      'it (mirrors negotiation page -> "Sign" button). create() enforces zengm\'s own free-agent ' +
      "willingness check; accept() enforces the real salary-cap gating.",
  },
  {
    area: "negotiateContract",
    confidence: "low",
    note:
      "This is the one method with no clean real-zengm equivalent. zengm only supports " +
      "renegotiating a contract for a player who is presently a free agent (including a player " +
      "in the brief re-sign window right after their old contract expires, who is internally " +
      "PLAYER.FREE_AGENT with first-refusal rights for their old team) -- there is no UI or API " +
      "path to change an ALREADY-signed, currently-rostered player's contract terms mid-deal. " +
      "adapter.ts first tries the real negotiation flow (core.contractNegotiation.create(pid, " +
      "resigning=true, tid) + api.main.acceptContractNegotiation), which succeeds correctly during the " +
      '"resigning" phase window. If that reports the player is not a free agent (i.e. they are ' +
      "still under an active, unexpired contract), it falls back to directly overwriting the " +
      "contract via core.player.setContract(p, {amount, exp}, true) and persisting the player row. " +
      "That fallback bypasses zengm's own mood/negotiation/salary-cap gating entirely -- it is an " +
      "intentional simplification to satisfy the SimulationEngine contract's unconditional " +
      "negotiateContract(pid, amount, years) signature, not a faithful reproduction of any real " +
      "zengm user flow.",
  },
  {
    area: "evaluateTrade",
    confidence: "medium",
    note:
      "Must not mutate. Real zengm's own trade evaluation (core.trade.propose) always reads from " +
      "a staged trade record in idb.cache.trade, which is itself written by core.trade.create -- " +
      "i.e. real zengm's UI flow inherently stages (mutates) a draft trade before evaluating it. " +
      'To honor "must not mutate", adapter.ts instead calls the same two pure computations ' +
      "propose() itself uses internally -- core.trade.summary(teams) for legality/payroll/warning " +
      "info, and `new team.ValueChangeCalculator().evaluate({...})` for the AI's value-change " +
      "verdict -- without ever calling trade.create. This should normally agree with what " +
      "executeTrade's real trade.propose() call decides, but because it bypasses the staged-trade " +
      "code path, exact parity with a live trade.propose() call is not independently verified.",
  },
  {
    area: "executeTrade",
    confidence: "high",
    note:
      "Implemented via the real api.main.createTrade(teams) + api.main.proposeTrade(false, conditions), the " +
      "same two calls zengm's own trade page performs when the user builds and proposes a trade. " +
      "Throws using the real rejection message if the AI (or a legality/salary-cap check) declines.",
  },
  {
    area: "advance() decision points",
    confidence: "medium",
    note:
      "The domain model's conceptual isBlocked()/nextDecision() state machine (see " +
      "tests/fixtures/FakeSimulationEngine.ts) is adapted, not transliterated, for real zengm: " +
      '"blocked on a pending decision" is defined here as "phase is DRAFT and the next pick in ' +
      "draft.getOrder() belongs to the user's team\" (i.e. it is literally the user's turn right " +
      'now), rather than the fake engine\'s simplified "user has picks left anywhere in the draft". ' +
      "This is a deliberate, more accurate adaptation to real zengm's turn-based draft order, not " +
      'an oversight. `next_decision` and `phase` targets are both implemented as "advance one ' +
      "zengm-phase-appropriate step (playMenu.day / untilDraft / runDraft(untilYourNextPick) / " +
      "untilResignPlayers / untilFreeAgency / untilRegularSeason, chosen by current phase) until " +
      "the zengm phase number changes or the user's draft turn arrives\" -- real zengm has no " +
      'separate concept of a "decision" that is finer-grained than a phase change or a draft turn, ' +
      "so unlike the fake engine, these two targets behave identically against the real engine.",
  },
  {
    area: "playMenu.untilFreeAgency confirm gate (adapter.ts: stepOneZengmPhase)",
    confidence: "high",
    note:
      "Confirmed against a real run: a bounded 20-attempt season-advance loop got stuck reporting " +
      '"hit_step_limit" every single attempt once it reached the RESIGN_PLAYERS phase, never ' +
      "progressing to FREE_AGENCY. Root cause: api.playMenu.untilFreeAgency " +
      "(src/worker/api/playMenu.ts) only calls phase.newPhase(FREE_AGENCY, ...) after " +
      'await toUI("confirm", [...]) resolves truthy -- and that toUI() call resolves to `undefined` ' +
      '(falsy) under NODE_ENV="test" (see the "toUI / cross-thread UI calls" entry above), so the ' +
      "phase transition silently never happens whenever any resign-window negotiations are still " +
      "pending, which is the common case for a real league. stepOneZengmPhase() special-cases " +
      "RESIGN_PLAYERS to call core.phase.newPhase(FREE_AGENCY, conditions) directly instead of " +
      "going through playMenu.untilFreeAgency -- the same call untilFreeAgency itself would have " +
      "made had the (headless, unanswerable) confirm dialog been accepted. Every other " +
      'PHASE_STEP_ACTION entry was checked against playMenu.ts for a similar toUI("confirm", ...) ' +
      "gate and none have one.",
  },
  {
    area: "PlayerSummary.rosterOrder uniqueness (mappings.ts: normalizeRosterOrder)",
    confidence: "high",
    note:
      "Confirmed against a real run: after releasePlayer + signFreeAgent + negotiateContract + " +
      "executeTrade + makeDraftPick in sequence on the same real league, the LINEUP_VALID invariant " +
      "(domain/invariants.ts) failed with duplicate rosterOrder values. Root cause: zengm's raw " +
      "rosterOrder field is not guaranteed to be a clean, unique 0..n-1 sequence at every moment -- " +
      "a freshly drafted player in particular can land with a rosterOrder that duplicates an " +
      "existing roster member's; zengm only reconciles this the next time something explicitly " +
      "re-sorts the depth chart (e.g. reorderRosterDrag), not automatically on every roster-" +
      "composition change (release/sign/trade/draft). getRawState() and getTeamRoster() both now " +
      "pass every roster through normalizeRosterOrder() (mappings.ts), which re-numbers to a stable, " +
      "unique 0..n-1 sequence ordered by existing rosterOrder (preserving any depth-chart order " +
      "already set via setLineup), tie-broken by pid, and recomputes role from the corrected order. " +
      "tests/fixtures/FakeSimulationEngine.ts had the identical class of bug (a released player " +
      "leaves a gap that a later push, keyed off array.length, can collide with) and got the same " +
      "fix, independently implemented, for the same reason.",
  },
  {
    area: "getTeamRoster (adapter.ts)",
    confidence: "high",
    note:
      "Added after the initial spike, once it became clear an agent cannot construct a real trade " +
      "proposal without seeing what a prospective partner actually has (get_state's roster view " +
      "only ever returned the user's own team). Implemented via the same real " +
      'idb.cache.players.indexGetAll("playersByTid", tid) store read getRawState() already uses for ' +
      "the user's own roster, parameterized by an arbitrary tid -- public roster info, matching " +
      "ordinary real-GM visibility (unlike hidden opponent valuations, which evaluateTrade " +
      "deliberately does not expose). Confirmed live against a real league.",
  },
];

/**
 * Second live-verification pass (after the initial spike above): every
 * previously-"high confidence, not independently exercised" mutation was
 * actually run against the same real checkout in one continuous episode --
 * getTeamRoster, setLineup, releasePlayer, signFreeAgent, negotiateContract
 * (the low-confidence fallback path specifically), executeTrade (a real
 * trade an actual opponent AI accepted), and makeDraftPick, followed by
 * end_episode. See tests/integration/realEngine.test.ts ("exercises every
 * remaining mutation...") and docs/ENGINE_INTEGRATION.md. Two real,
 * previously-unknown issues were found and fixed by that run, not by
 * further code review: signFreeAgent's real salary-cap gating rejects any
 * offer above the league minimum contract for a team already over the cap
 * (confirmed correct zengm behavior, not a bug in this adapter -- the test
 * now signs at the real minContract default of $1.2M); and the
 * rosterOrder-uniqueness issue documented above. Every SimulationEngine
 * method now has at least one real, live, passing exercise on record.
 */

/** Convenience lookup used in error/log messages that reference a known gap. */
export function describeIncompatibility(area: string): string | undefined {
  return KNOWN_INCOMPATIBILITIES.find((entry) => entry.area === area)?.note;
}
