import type { SimulationEngine } from "../../src/domain/SimulationEngine.js";
import type {
  EngineEvent,
  EngineOption,
  EngineRawState,
} from "../../src/domain/types.js";

type CreateInput = Parameters<SimulationEngine["create"]>[0];
type AdvanceInput = Parameters<SimulationEngine["advance"]>[0];

/** Deterministic protocol fixture; it is not a Basketball GM implementation. */
export class DeterministicDemoEngine implements SimulationEngine {
  readonly metadata = {
    name: "external-policy-protocol-fixture",
    version: "1",
  };

  private state: EngineRawState | undefined;
  private closed = false;

  async create(input: CreateInput): Promise<void> {
    this.closed = false;
    const roster = Array.from({ length: 10 }, (_, index) => ({
      pid: index + 1,
      name: `Fixture Player ${index + 1}`,
      age: 22 + (index % 8),
      position: ["PG", "SG", "SF", "PF", "C"][index % 5] ?? "G",
      overall: 60 + (index % 10),
      potential: 65 + (index % 10),
      contractAmount: 10,
      contractExpires: input.startingSeason + 2,
      injuryGamesRemaining: 0,
      role: index < 5 ? ("starter" as const) : ("bench" as const),
      rosterOrder: index,
    }));
    this.state = {
      season: input.startingSeason,
      phase: "preseason",
      day: 0,
      userTeam: {
        tid: input.userTeamId,
        name: "Protocol Fixture",
        abbrev: "FIX",
        won: 0,
        lost: 0,
        conference: "Research",
        division: "Harness",
        standing: 1,
        payroll: 100,
        salaryCap: 140,
        capSpace: 40,
        luxuryTaxThreshold: 168,
        hardCapActive: false,
        minContract: 1.2,
        maxContract: 45,
      },
      roster,
      freeAgents: [],
      draftProspects: [],
      draftPicks: [],
      ownedPicks: [],
      standings: [],
      schedule: [],
      recentTransactions: [],
      legalActionCategories: ["advance"],
      nextDecision: "advance_simulation",
    };
  }

  async getRawState(): Promise<EngineRawState> {
    return structuredClone(this.requireState());
  }

  async getOptions(): Promise<EngineOption[]> {
    return [{ type: "advance", target: "next_game" }];
  }

  async getTeamRoster(_tid: number) {
    return [];
  }

  async getPlayer(pid: number) {
    return {
      pid,
      ratingsHistory: [],
      statsHistory: [],
      contractSchedule: [],
      awards: [],
      injuryHistory: [],
    };
  }

  async evaluateTrade() {
    return {
      legal: false,
      acceptedByOtherTeam: null,
      reasons: ["Protocol fixture does not implement trades"],
      payrollDelta: 0,
      rosterSizeDelta: 0,
      assetsExchanged: { offered: [], requested: [] },
    };
  }

  async executeTrade(): Promise<EngineEvent[]> {
    return this.unsupported("execute_trade");
  }

  async setLineup(): Promise<EngineEvent[]> {
    return this.unsupported("set_lineup");
  }

  async releasePlayer(): Promise<EngineEvent[]> {
    return this.unsupported("release_player");
  }

  async negotiateContract(): Promise<EngineEvent[]> {
    return this.unsupported("negotiate_contract");
  }

  async signFreeAgent(): Promise<EngineEvent[]> {
    return this.unsupported("sign_free_agent");
  }

  async makeDraftPick(): Promise<EngineEvent[]> {
    return this.unsupported("make_draft_pick");
  }

  async advance(input: AdvanceInput): Promise<EngineEvent[]> {
    const state = this.requireState();
    const count =
      input.target === "days" || input.target === "games"
        ? (input.count ?? 1)
        : 1;
    state.day = (state.day ?? 0) + count;
    return [
      {
        type: "advance_complete",
        target: input.target,
        count,
        reason: "protocol_fixture_step",
      },
    ];
  }

  async exportSnapshot(): Promise<unknown> {
    return { state: structuredClone(this.requireState()) };
  }

  async importSnapshot(snapshot: unknown): Promise<void> {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !("state" in snapshot)
    ) {
      throw new Error("Invalid protocol fixture snapshot");
    }
    this.state = structuredClone(snapshot.state as EngineRawState);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private requireState(): EngineRawState {
    if (this.closed || this.state === undefined) {
      throw new Error("Protocol fixture is not active");
    }
    return this.state;
  }

  private unsupported(operation: string): never {
    throw new Error(`Protocol fixture does not implement ${operation}`);
  }
}
