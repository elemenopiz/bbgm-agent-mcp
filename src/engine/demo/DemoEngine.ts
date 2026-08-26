import seedrandom from "seedrandom";

import type { SimulationEngine } from "../../domain/SimulationEngine.js";
import type {
  AdvanceInput,
  CreateEpisodeInput,
  LeagueState,
  PlayerSummary,
  TradeEvaluation,
  TradeProposal,
} from "../../domain/types.js";

type Arc4State = Record<"i" | "j", number> & { S: number[] };

type DemoSnapshot = {
  input: CreateEpisodeInput;
  gamesPlayed: number;
  won: number;
  roster: PlayerSummary[];
  rngState: Arc4State;
};

export class DemoEngine implements SimulationEngine {
  readonly metadata = { name: "deterministic-demo", version: "0.1.0" };

  private input?: CreateEpisodeInput;
  private gamesPlayed = 0;
  private won = 0;
  private roster: PlayerSummary[] = [];
  private rng = seedrandom("uninitialized", { state: true });

  async create(input: CreateEpisodeInput): Promise<void> {
    this.input = input;
    this.rng = seedrandom(input.seed, { state: true });
    this.gamesPlayed = 0;
    this.won = 0;
    this.roster = Array.from({ length: 12 }, (_, index) => ({
      pid: index + 1,
      name: `Research Player ${index + 1}`,
      age: 20 + Math.floor(this.rng() * 14),
      position: ["PG", "SG", "SF", "PF", "C"][index % 5] ?? "G",
      overall: 40 + Math.floor(this.rng() * 40),
      potential: 50 + Math.floor(this.rng() * 35),
      contractAmount: 1 + Math.floor(this.rng() * 25),
      contractExpires: input.startingSeason + 1 + Math.floor(this.rng() * 4),
      injuryGamesRemaining: 0,
    }));
  }

  async getState(): Promise<Omit<LeagueState, "stateHash" | "revision" | "status">> {
    const input = this.requireInput();
    const payroll = this.roster.reduce((sum, player) => sum + player.contractAmount, 0);
    const salaryCap = 140;
    return {
      schemaVersion: "1",
      episodeId: input.episodeId,
      scenarioId: input.scenarioId,
      seed: input.seed,
      engine: this.metadata,
      season: input.startingSeason + Math.floor(this.gamesPlayed / 82),
      phase: "regular_season",
      userTeam: {
        tid: input.userTeamId,
        name: "Demo Research Team",
        won: this.won,
        lost: this.gamesPlayed - this.won,
        payroll,
        salaryCap,
        capSpace: salaryCap - payroll,
      },
      roster: structuredClone(this.roster),
      constraints: [
        {
          code: "ROSTER_MINIMUM",
          satisfied: this.roster.length >= 10,
          message: `${this.roster.length} players; minimum is 10`,
        },
      ],
      legalActionCategories: ["advance", "evaluate_trade", "execute_trade"],
      nextDecision: "next_game",
    };
  }

  async getOptions(): Promise<Array<Record<string, unknown>>> {
    return [
      { type: "advance", target: "next_game" },
      { type: "advance", target: "games", maxCount: 30 },
    ];
  }

  async evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation> {
    const offeredPlayers = proposal.offered.filter((asset) => asset.type === "player");
    const requestedPlayers = proposal.requested.filter((asset) => asset.type === "player");
    const owned = new Set(this.roster.map((player) => player.pid));
    const legal = offeredPlayers.every((asset) => owned.has(asset.pid));
    return {
      legal,
      acceptedByOtherTeam: legal ? false : null,
      reasons: legal ? ["Demo engine does not model opponent acceptance"] : ["Offered player not owned"],
      payrollDelta: 0,
      rosterSizeDelta: requestedPlayers.length - offeredPlayers.length,
    };
  }

  async executeTrade(proposal: TradeProposal): Promise<Array<Record<string, unknown>>> {
    const evaluation = await this.evaluateTrade(proposal);
    if (!evaluation.legal || evaluation.acceptedByOtherTeam !== true) {
      throw new Error("Trade is not executable");
    }
    return [{ type: "trade", otherTeamId: proposal.otherTeamId }];
  }

  async advance(input: AdvanceInput): Promise<Array<Record<string, unknown>>> {
    const count = input.target === "games" ? (input.count ?? 1) : 1;
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < count; index += 1) {
      const won = this.rng() >= 0.5;
      this.gamesPlayed += 1;
      if (won) this.won += 1;
      events.push({ type: "game", game: this.gamesPlayed, result: won ? "win" : "loss" });
    }
    return events;
  }

  async exportSnapshot(): Promise<DemoSnapshot> {
    return {
      input: structuredClone(this.requireInput()),
      gamesPlayed: this.gamesPlayed,
      won: this.won,
      roster: structuredClone(this.roster),
      rngState: this.rng.state(),
    };
  }

  async importSnapshot(value: unknown): Promise<void> {
    const snapshot = value as DemoSnapshot;
    this.input = structuredClone(snapshot.input);
    this.gamesPlayed = snapshot.gamesPlayed;
    this.won = snapshot.won;
    this.roster = structuredClone(snapshot.roster);
    this.rng = seedrandom("restored", { state: snapshot.rngState });
  }

  async close(): Promise<void> {}

  private requireInput(): CreateEpisodeInput {
    if (!this.input) throw new Error("Demo engine has not been initialized");
    return this.input;
  }
}
