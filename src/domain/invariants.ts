import type {
  ConstraintStatus,
  EngineRawState,
  ScenarioConstraintSpec,
} from "./types.js";

// zengm reads these from league game attributes (minRosterSize/maxRosterSize),
// which are configurable and differ by sport. These are the basketball
// defaults, used only when the engine has not reported its own bounds.
const ROSTER_MIN_DEFAULT = 10;
const ROSTER_MAX_DEFAULT = 15;

export const BUILTIN_INVARIANT_CODES = [
  "ROSTER_SIZE",
  "NO_DUPLICATE_PLAYERS",
  "NO_DUPLICATE_PICKS",
  "VALID_CONTRACTS",
  "CAP_COMPLIANCE",
  "FINITE_VALUES",
  "SEASON_PROGRESSION",
  "LINEUP_VALID",
] as const;

export const isBuiltinInvariantCode = (code: string): boolean =>
  (BUILTIN_INVARIANT_CODES as readonly string[]).includes(code);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const checkRosterSize = (state: EngineRawState): ConstraintStatus => {
  const size = state.roster.length;
  const ROSTER_MIN = state.rosterMin ?? ROSTER_MIN_DEFAULT;
  const ROSTER_MAX = state.rosterMax ?? ROSTER_MAX_DEFAULT;
  // The real engine temporarily moves expiring players to free agency while
  // entering its resigning window. A below-minimum roster is therefore a
  // legal, actionable transitional state through the resigning/free-agency
  // management window; the bound becomes hard once the season resumes.
  const allowsTemporaryShortRoster =
    state.phase === "resigning" || state.phase === "free_agency";
  const satisfied =
    (size >= ROSTER_MIN || allowsTemporaryShortRoster) && size <= ROSTER_MAX;
  return {
    code: "ROSTER_SIZE",
    kind: "hard",
    satisfied,
    message: satisfied
      ? allowsTemporaryShortRoster && size < ROSTER_MIN
        ? `Roster has ${size} players; temporary short roster is allowed during ${state.phase}`
        : `Roster has ${size} players (${ROSTER_MIN}-${ROSTER_MAX} required)`
      : `Roster has ${size} players; must be between ${ROSTER_MIN} and ${ROSTER_MAX}`,
  };
};

const checkNoDuplicatePlayers = (state: EngineRawState): ConstraintStatus => {
  const pids = state.roster.map((player) => player.pid);
  const duplicates = pids.length !== new Set(pids).size;
  return {
    code: "NO_DUPLICATE_PLAYERS",
    kind: "hard",
    satisfied: !duplicates,
    message: duplicates
      ? "Roster contains duplicate player IDs"
      : "No duplicate player ownership",
  };
};

const checkNoDuplicatePicks = (state: EngineRawState): ConstraintStatus => {
  const dpids = state.ownedPicks.map((pick) => pick.dpid);
  const duplicates = dpids.length !== new Set(dpids).size;
  return {
    code: "NO_DUPLICATE_PICKS",
    kind: "hard",
    satisfied: !duplicates,
    message: duplicates
      ? "Owned draft picks contain duplicate IDs"
      : "No duplicate draft-pick ownership",
  };
};

const checkValidContracts = (state: EngineRawState): ConstraintStatus => {
  // Basketball GM intentionally keeps players with contracts expiring in the
  // current season on the roster during the resigning window. They remain
  // actionable roster assets at that phase, so rejecting them would turn a
  // legitimate engine transition into a false invariant failure.
  const allowsExpiringContracts = state.phase === "resigning";
  const invalid = state.roster.filter(
    (player) =>
      !(player.contractAmount > 0) ||
      (!allowsExpiringContracts && player.contractExpires < state.season),
  );
  return {
    code: "VALID_CONTRACTS",
    kind: "hard",
    satisfied: invalid.length === 0,
    message:
      invalid.length === 0
        ? allowsExpiringContracts
          ? "All contracts have positive value; current-season expirations are allowed during resigning"
          : "All contracts have positive value and unexpired terms"
        : `${invalid.length} player(s) have invalid contract amount or expiration: ${invalid
            .map((player) => player.pid)
            .join(", ")}`,
  };
};

const checkCapCompliance = (state: EngineRawState): ConstraintStatus => {
  const { payroll, salaryCap, hardCapActive } = state.userTeam;
  const overCap = payroll > salaryCap;
  return {
    code: "CAP_COMPLIANCE",
    kind: hardCapActive ? "hard" : "soft",
    satisfied: hardCapActive ? !overCap : true,
    message: hardCapActive
      ? overCap
        ? `Payroll ${payroll} exceeds hard cap of ${salaryCap}`
        : `Payroll ${payroll} is within the hard cap of ${salaryCap}`
      : overCap
        ? `Payroll ${payroll} exceeds the soft cap of ${salaryCap} (allowed via exceptions)`
        : `Payroll ${payroll} is within the soft cap of ${salaryCap}`,
  };
};

const checkFiniteValues = (state: EngineRawState): ConstraintStatus => {
  const numericFields = [
    state.userTeam.payroll,
    state.userTeam.salaryCap,
    state.userTeam.capSpace,
    state.userTeam.won,
    state.userTeam.lost,
    ...state.roster.flatMap((player) => [
      player.age,
      player.overall,
      player.potential,
      player.contractAmount,
    ]),
  ];
  const allFinite = numericFields.every(isFiniteNumber);
  return {
    code: "FINITE_VALUES",
    kind: "hard",
    satisfied: allFinite,
    message: allFinite
      ? "All observed numeric values are finite"
      : "Non-finite numeric value detected in league state",
  };
};

const checkSeasonProgression = (
  state: EngineRawState,
  startingSeason: number,
): ConstraintStatus => {
  const satisfied = state.season >= startingSeason;
  return {
    code: "SEASON_PROGRESSION",
    kind: "hard",
    satisfied,
    message: satisfied
      ? `Season ${state.season} is at or after the starting season ${startingSeason}`
      : `Season ${state.season} regressed before starting season ${startingSeason}`,
  };
};

const checkLineupRepresentation = (state: EngineRawState): ConstraintStatus => {
  const orders = state.roster.map((player) => player.rosterOrder);
  const valid =
    new Set(orders).size === orders.length &&
    orders.every((order) => order >= 0);
  return {
    code: "LINEUP_VALID",
    kind: "hard",
    satisfied: valid,
    message: valid
      ? "Roster order assignments are unique and non-negative"
      : "Roster order assignments are invalid",
  };
};

/**
 * Built-in state invariants that run after every mutation regardless of
 * scenario configuration. A hard-kind failure here rolls back the mutation.
 */
export const runBuiltinInvariants = (
  state: EngineRawState,
  startingSeason: number,
): ConstraintStatus[] => [
  checkRosterSize(state),
  checkNoDuplicatePlayers(state),
  checkNoDuplicatePicks(state),
  checkValidContracts(state),
  checkCapCompliance(state),
  checkFiniteValues(state),
  checkSeasonProgression(state, startingSeason),
  checkLineupRepresentation(state),
];

/**
 * Scenario-declared constraints layered on top of the built-ins. Codes that
 * match a built-in are informational duplicates (the built-in already
 * enforces them). Unknown codes are represented as unsatisfied, but normal
 * episode creation rejects them before an agent can run an ambiguous
 * scenario. This prevents an unenforced hard rule from being reported as
 * satisfied.
 */
export const evaluateScenarioConstraints = (
  spec: ScenarioConstraintSpec,
  builtins: ConstraintStatus[],
): ConstraintStatus[] => {
  const byCode = new Map(builtins.map((status) => [status.code, status]));
  return spec.hard.map((definition) => {
    const builtin = byCode.get(definition.code);
    if (builtin)
      return {
        ...builtin,
        message: `${definition.description}: ${builtin.message}`,
      };
    return {
      code: definition.code,
      kind: "hard" as const,
      satisfied: false,
      message: `${definition.description} (unsupported constraint evaluator)`,
    };
  });
};

export const hasHardFailure = (statuses: ConstraintStatus[]): boolean =>
  statuses.some((status) => status.kind === "hard" && !status.satisfied);
