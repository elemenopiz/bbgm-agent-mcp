import seedrandom from "seedrandom";

import type { SimulationEngine } from "../../src/domain/SimulationEngine.js";
import type {
  AdvanceInput,
  CreateEpisodeInput,
  DraftPickSummary,
  EngineEvent,
  EngineRawState,
  MakeDraftPickInput,
  NegotiateContractInput,
  Phase,
  PlayerSummary,
  ProspectSummary,
  ReleasePlayerInput,
  SetLineupInput,
  SignFreeAgentInput,
  TradeEvaluation,
  TradeProposal,
  TransactionRecord,
} from "../../src/domain/types.js";

const SEASON_GAMES = 12;
const PLAYOFF_GAMES = 4;
const OPPONENT_TIDS = [9001, 9002, 9003, 9004, 9005];
const MAX_ADVANCE_STEPS = 400;

type OpponentAssets = { players: PlayerSummary[]; picks: DraftPickSummary[] };
type OpponentStanding = { tid: number; won: number; lost: number };

type FakeSnapshot = {
  input: CreateEpisodeInput;
  season: number;
  phase: Phase;
  day: number;
  gamesPlayedThisSeason: number;
  playoffGamesPlayed: number;
  playoffGamesTarget: number;
  pendingDraftPicksThisSeason: number;
  roster: PlayerSummary[];
  freeAgents: PlayerSummary[];
  draftProspects: ProspectSummary[];
  ownedPicks: DraftPickSummary[];
  opponents: [number, OpponentAssets][];
  opponentStandings: OpponentStanding[];
  userWon: number;
  userLost: number;
  transactions: TransactionRecord[];
  nextEntityId: number;
  rngState: unknown;
};

const playerValue = (player: PlayerSummary): number =>
  player.overall * 2 + player.potential;
const pickValue = (pick: DraftPickSummary): number =>
  pick.round === 1 ? 40 : 15;

/**
 * A small, fully deterministic in-process simulation used only in unit tests.
 * It exercises every operation on SimulationEngine with plausible-but-fake
 * data, keeping seasons short (SEASON_GAMES) so determinism and multi-season
 * tests run fast. Never used by the production server.
 */
export class FakeSimulationEngine implements SimulationEngine {
  readonly metadata = { name: "fake-simulation-engine", version: "test" };

  private input?: CreateEpisodeInput;
  private season = 0;
  private phase: Phase = "preseason";
  private day = 0;
  private gamesPlayedThisSeason = 0;
  private playoffGamesPlayed = 0;
  private playoffGamesTarget = 0;
  private pendingDraftPicksThisSeason = 0;
  private roster: PlayerSummary[] = [];
  private freeAgents: PlayerSummary[] = [];
  private draftProspects: ProspectSummary[] = [];
  private ownedPicks: DraftPickSummary[] = [];
  private opponents = new Map<number, OpponentAssets>();
  private opponentStandings: OpponentStanding[] = [];
  private userWon = 0;
  private userLost = 0;
  private transactions: TransactionRecord[] = [];
  private nextEntityId = 1;
  private closed = false;
  private rng: seedrandom.StatefulPRNG<seedrandom.State.Arc4> = seedrandom(
    "uninitialized",
    { state: true },
  );

  async create(input: CreateEpisodeInput): Promise<void> {
    this.input = input;
    this.rng = seedrandom(input.seed, { state: true });
    this.season = input.startingSeason;
    this.phase = "preseason";
    this.day = 0;
    this.gamesPlayedThisSeason = 0;
    this.playoffGamesPlayed = 0;
    this.playoffGamesTarget = 0;
    this.pendingDraftPicksThisSeason = 0;
    this.userWon = 0;
    this.userLost = 0;
    this.transactions = [];
    this.nextEntityId = 1;

    this.roster = Array.from({ length: 12 }, () =>
      this.generatePlayer("bench"),
    );
    this.roster.forEach((player, index) => {
      player.rosterOrder = index;
      player.role = index < 5 ? "starter" : index < 8 ? "rotation" : "bench";
    });
    this.freeAgents = Array.from({ length: 10 }, () =>
      this.generatePlayer("bench"),
    );
    this.draftProspects = [];
    this.ownedPicks = Array.from({ length: 6 }, (_, index) => ({
      dpid: this.nextEntityId++,
      season: input.startingSeason + 1 + Math.floor(index / 2),
      round: index % 2 === 0 ? 1 : 2,
      originalTeamId: input.userTeamId,
      currentTeamId: input.userTeamId,
    }));

    this.opponents = new Map(
      OPPONENT_TIDS.map((tid) => [
        tid,
        {
          players: Array.from({ length: 3 }, () =>
            this.generatePlayer("bench"),
          ),
          picks: Array.from({ length: 2 }, (_, index) => ({
            dpid: this.nextEntityId++,
            season: input.startingSeason + 1,
            round: index === 0 ? 1 : 2,
            originalTeamId: tid,
            currentTeamId: tid,
          })),
        },
      ]),
    );
    this.opponentStandings = OPPONENT_TIDS.map((tid) => ({
      tid,
      won: 0,
      lost: 0,
    }));
  }

  async getRawState(): Promise<EngineRawState> {
    const input = this.requireInput();
    const payroll = this.roster.reduce(
      (sum, player) => sum + player.contractAmount,
      0,
    );
    const salaryCap = 140;
    const standings = this.computeStandings(input.userTeamId);
    const userStanding = standings.find(
      (team) => team.tid === input.userTeamId,
    );
    return {
      season: this.season,
      phase: this.phase,
      day: this.day,
      userTeam: {
        tid: input.userTeamId,
        name: "Research Test Team",
        abbrev: "RES",
        won: this.userWon,
        lost: this.userLost,
        conference: "Research",
        division: "Sandbox",
        standing: userStanding?.rank ?? standings.length,
        payroll,
        salaryCap,
        capSpace: salaryCap - payroll,
        luxuryTaxThreshold: salaryCap * 1.2,
        hardCapActive: false,
      },
      roster: structuredClone(this.roster),
      freeAgents: structuredClone(this.freeAgents),
      draftProspects: structuredClone(this.draftProspects),
      ownedPicks: structuredClone(this.ownedPicks),
      standings,
      schedule: this.computeSchedule(),
      recentTransactions: structuredClone(this.transactions).slice(-20),
      legalActionCategories: this.legalActionCategories(),
      nextDecision: this.nextDecision(),
    };
  }

  async getOptions(): Promise<({ type: string } & Record<string, unknown>)[]> {
    const options: ({ type: string } & Record<string, unknown>)[] = [
      { type: "advance", target: "next_game" },
      { type: "advance", target: "next_decision" },
    ];
    if (this.phase === "draft" && this.pendingDraftPicksThisSeason > 0) {
      options.push(
        ...this.draftProspects.map((prospect) => ({
          type: "make_draft_pick",
          pid: prospect.pid,
          name: prospect.name,
        })),
      );
    }
    if (this.freeAgents.length > 0) {
      options.push(
        ...this.freeAgents.map((player) => ({
          type: "sign_free_agent",
          pid: player.pid,
          name: player.name,
        })),
      );
    }
    options.push(
      ...this.roster.map((player) => ({
        type: "release_player",
        pid: player.pid,
        name: player.name,
      })),
    );
    return options;
  }

  async evaluateTrade(proposal: TradeProposal): Promise<TradeEvaluation> {
    const reasons: string[] = [];
    const ownedPids = new Set(this.roster.map((player) => player.pid));
    const ownedDpids = new Set(this.ownedPicks.map((pick) => pick.dpid));
    for (const asset of proposal.offered) {
      if (asset.type === "player" && !ownedPids.has(asset.pid))
        reasons.push(`Offered player ${asset.pid} not owned`);
      if (asset.type === "draft_pick" && !ownedDpids.has(asset.dpid))
        reasons.push(`Offered pick ${asset.dpid} not owned`);
    }
    const opponent = this.opponents.get(proposal.otherTeamId);
    if (!opponent) {
      reasons.push(`Unknown trade partner team ${proposal.otherTeamId}`);
    } else {
      const opponentPids = new Set(
        opponent.players.map((player) => player.pid),
      );
      const opponentDpids = new Set(opponent.picks.map((pick) => pick.dpid));
      for (const asset of proposal.requested) {
        if (asset.type === "player" && !opponentPids.has(asset.pid))
          reasons.push(
            `Requested player ${asset.pid} not owned by team ${proposal.otherTeamId}`,
          );
        if (asset.type === "draft_pick" && !opponentDpids.has(asset.dpid))
          reasons.push(
            `Requested pick ${asset.dpid} not owned by team ${proposal.otherTeamId}`,
          );
      }
    }
    const legal = reasons.length === 0;

    let offeredValue = 0;
    let requestedValue = 0;
    let payrollDelta = 0;
    if (legal && opponent) {
      for (const asset of proposal.offered) {
        if (asset.type === "player") {
          const player = this.roster.find((p) => p.pid === asset.pid);
          if (player) {
            offeredValue += playerValue(player);
            payrollDelta -= player.contractAmount;
          }
        } else {
          const pick = this.ownedPicks.find((p) => p.dpid === asset.dpid);
          if (pick) offeredValue += pickValue(pick);
        }
      }
      for (const asset of proposal.requested) {
        if (asset.type === "player") {
          const player = opponent.players.find((p) => p.pid === asset.pid);
          if (player) {
            requestedValue += playerValue(player);
            payrollDelta += player.contractAmount;
          }
        } else {
          const pick = opponent.picks.find((p) => p.dpid === asset.dpid);
          if (pick) requestedValue += pickValue(pick);
        }
      }
    }
    const acceptedByOtherTeam = legal
      ? offeredValue >= requestedValue * 0.85
      : null;
    if (legal && acceptedByOtherTeam === false)
      reasons.push(
        "Opponent values the requested assets higher than what was offered",
      );

    return {
      legal,
      acceptedByOtherTeam,
      reasons: reasons.length === 0 ? ["Trade is legal and balanced"] : reasons,
      payrollDelta,
      rosterSizeDelta:
        proposal.requested.filter((a) => a.type === "player").length -
        proposal.offered.filter((a) => a.type === "player").length,
      assetsExchanged: {
        offered: proposal.offered,
        requested: proposal.requested,
      },
    };
  }

  async executeTrade(proposal: TradeProposal): Promise<EngineEvent[]> {
    const evaluation = await this.evaluateTrade(proposal);
    if (!evaluation.legal || evaluation.acceptedByOtherTeam !== true) {
      throw new Error(
        `Trade is not executable: ${evaluation.reasons.join("; ")}`,
      );
    }
    const opponent = this.opponents.get(proposal.otherTeamId);
    if (!opponent)
      throw new Error(`Unknown trade partner ${proposal.otherTeamId}`);

    for (const asset of proposal.offered) {
      if (asset.type === "player") {
        const index = this.roster.findIndex((p) => p.pid === asset.pid);
        if (index >= 0) opponent.players.push(...this.roster.splice(index, 1));
      } else {
        const index = this.ownedPicks.findIndex((p) => p.dpid === asset.dpid);
        if (index >= 0) {
          const [pick] = this.ownedPicks.splice(index, 1);
          if (pick)
            opponent.picks.push({
              ...pick,
              currentTeamId: proposal.otherTeamId,
            });
        }
      }
    }
    for (const asset of proposal.requested) {
      if (asset.type === "player") {
        const index = opponent.players.findIndex((p) => p.pid === asset.pid);
        if (index >= 0) {
          const [player] = opponent.players.splice(index, 1);
          if (player) {
            player.rosterOrder = this.roster.length;
            player.role = "bench";
            this.roster.push(player);
          }
        }
      } else {
        const index = opponent.picks.findIndex((p) => p.dpid === asset.dpid);
        if (index >= 0) {
          const [pick] = opponent.picks.splice(index, 1);
          if (pick)
            this.ownedPicks.push({
              ...pick,
              currentTeamId: this.requireInput().userTeamId,
            });
        }
      }
    }
    this.recordTransaction("trade", `Trade with team ${proposal.otherTeamId}`, [
      this.requireInput().userTeamId,
      proposal.otherTeamId,
    ]);
    return [{ type: "trade", otherTeamId: proposal.otherTeamId }];
  }

  async setLineup(input: SetLineupInput): Promise<EngineEvent[]> {
    const byPid = new Map(this.roster.map((player) => [player.pid, player]));
    input.order.forEach((pid, index) => {
      const player = byPid.get(pid);
      if (!player) return;
      player.rosterOrder = index;
      player.role = index < 5 ? "starter" : index < 8 ? "rotation" : "bench";
    });
    return [{ type: "lineup_set", order: input.order }];
  }

  async releasePlayer(input: ReleasePlayerInput): Promise<EngineEvent[]> {
    const index = this.roster.findIndex((player) => player.pid === input.pid);
    if (index === -1)
      throw new Error(`Player ${input.pid} is not on the roster`);
    const [player] = this.roster.splice(index, 1);
    if (player)
      this.freeAgents.push({
        ...player,
        role: "bench",
        rosterOrder: this.freeAgents.length,
      });
    this.recordTransaction("release", `Released player ${input.pid}`, [
      this.requireInput().userTeamId,
    ]);
    return [{ type: "release", pid: input.pid }];
  }

  async negotiateContract(
    input: NegotiateContractInput,
  ): Promise<EngineEvent[]> {
    const player = this.roster.find((p) => p.pid === input.pid);
    if (!player) throw new Error(`Player ${input.pid} is not on the roster`);
    player.contractAmount = input.amount;
    player.contractExpires = this.season + input.years;
    this.recordTransaction(
      "contract_extension",
      `Extended player ${input.pid}`,
      [this.requireInput().userTeamId],
    );
    return [
      {
        type: "contract_extension",
        pid: input.pid,
        amount: input.amount,
        years: input.years,
      },
    ];
  }

  async signFreeAgent(input: SignFreeAgentInput): Promise<EngineEvent[]> {
    const index = this.freeAgents.findIndex(
      (player) => player.pid === input.pid,
    );
    if (index === -1)
      throw new Error(`Player ${input.pid} is not a free agent`);
    const [player] = this.freeAgents.splice(index, 1);
    if (player) {
      player.contractAmount = input.amount;
      player.contractExpires = this.season + input.years;
      player.rosterOrder = this.roster.length;
      player.role = "bench";
      this.roster.push(player);
    }
    this.recordTransaction("sign", `Signed free agent ${input.pid}`, [
      this.requireInput().userTeamId,
    ]);
    return [
      {
        type: "sign",
        pid: input.pid,
        amount: input.amount,
        years: input.years,
      },
    ];
  }

  async makeDraftPick(input: MakeDraftPickInput): Promise<EngineEvent[]> {
    const index = this.draftProspects.findIndex(
      (prospect) => prospect.pid === input.pid,
    );
    if (index === -1) throw new Error(`Prospect ${input.pid} is not available`);
    if (this.pendingDraftPicksThisSeason <= 0)
      throw new Error("No draft picks remain");
    const [prospect] = this.draftProspects.splice(index, 1);
    if (prospect) {
      this.roster.push({
        pid: prospect.pid,
        name: prospect.name,
        age: prospect.age,
        position: prospect.position,
        overall: prospect.scoutedOverall,
        potential: prospect.scoutedPotential,
        contractAmount: 2,
        contractExpires: this.season + 2,
        injuryGamesRemaining: 0,
        role: "bench",
        rosterOrder: this.roster.length,
      });
    }
    if (this.ownedPicks.length > 0) this.ownedPicks.shift();
    this.pendingDraftPicksThisSeason -= 1;
    this.recordTransaction("draft", `Drafted prospect ${input.pid}`, [
      this.requireInput().userTeamId,
    ]);
    return [{ type: "draft", pid: input.pid }];
  }

  async advance(input: AdvanceInput): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    const stop = (reason: string): EngineEvent[] => {
      events.push({ type: "advance_complete", reason });
      return events;
    };

    switch (input.target) {
      case "next_game": {
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (this.isBlocked()) return stop("blocked_pending_decision");
          const stepEvents = this.stepOneDay();
          events.push(...stepEvents);
          if (stepEvents.some((event) => event.type === "game"))
            return stop("played_one_game");
        }
        return stop("hit_step_limit");
      }
      case "next_decision": {
        const start = this.nextDecision();
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (this.isBlocked()) return stop("blocked_pending_decision");
          events.push(...this.stepOneDay());
          if (this.nextDecision() !== start)
            return stop("reached_next_decision");
        }
        return stop("hit_step_limit");
      }
      case "days": {
        const count = input.count ?? 1;
        for (let i = 0; i < count; i += 1) {
          if (this.isBlocked()) return stop("blocked_pending_decision");
          events.push(...this.stepOneDay());
        }
        return stop("completed_requested_days");
      }
      case "games": {
        const count = input.count ?? 1;
        let played = 0;
        for (
          let step = 0;
          step < MAX_ADVANCE_STEPS && played < count;
          step += 1
        ) {
          if (this.isBlocked()) return stop("blocked_pending_decision");
          const stepEvents = this.stepOneDay();
          events.push(...stepEvents);
          if (stepEvents.some((event) => event.type === "game")) played += 1;
        }
        return stop(
          played >= count ? "completed_requested_games" : "hit_step_limit",
        );
      }
      case "phase": {
        const start = this.phase;
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (this.isBlocked()) return stop("blocked_pending_decision");
          events.push(...this.stepOneDay());
          if (this.phase !== start) return stop("reached_next_phase");
        }
        return stop("hit_step_limit");
      }
      case "season_end": {
        const start = this.season;
        for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
          if (this.isBlocked()) return stop("blocked_pending_decision");
          events.push(...this.stepOneDay());
          if (this.season !== start) return stop("season_complete");
        }
        return stop("hit_step_limit");
      }
    }
  }

  async exportSnapshot(): Promise<FakeSnapshot> {
    return {
      input: structuredClone(this.requireInput()),
      season: this.season,
      phase: this.phase,
      day: this.day,
      gamesPlayedThisSeason: this.gamesPlayedThisSeason,
      playoffGamesPlayed: this.playoffGamesPlayed,
      playoffGamesTarget: this.playoffGamesTarget,
      pendingDraftPicksThisSeason: this.pendingDraftPicksThisSeason,
      roster: structuredClone(this.roster),
      freeAgents: structuredClone(this.freeAgents),
      draftProspects: structuredClone(this.draftProspects),
      ownedPicks: structuredClone(this.ownedPicks),
      opponents: [...this.opponents.entries()].map(([tid, assets]) => [
        tid,
        structuredClone(assets),
      ]),
      opponentStandings: structuredClone(this.opponentStandings),
      userWon: this.userWon,
      userLost: this.userLost,
      transactions: structuredClone(this.transactions),
      nextEntityId: this.nextEntityId,
      rngState: this.rng.state(),
    };
  }

  async importSnapshot(value: unknown): Promise<void> {
    const snapshot = value as FakeSnapshot;
    this.input = structuredClone(snapshot.input);
    this.season = snapshot.season;
    this.phase = snapshot.phase;
    this.day = snapshot.day;
    this.gamesPlayedThisSeason = snapshot.gamesPlayedThisSeason;
    this.playoffGamesPlayed = snapshot.playoffGamesPlayed;
    this.playoffGamesTarget = snapshot.playoffGamesTarget;
    this.pendingDraftPicksThisSeason = snapshot.pendingDraftPicksThisSeason;
    this.roster = structuredClone(snapshot.roster);
    this.freeAgents = structuredClone(snapshot.freeAgents);
    this.draftProspects = structuredClone(snapshot.draftProspects);
    this.ownedPicks = structuredClone(snapshot.ownedPicks);
    this.opponents = new Map(
      snapshot.opponents.map(([tid, assets]) => [tid, structuredClone(assets)]),
    );
    this.opponentStandings = structuredClone(snapshot.opponentStandings);
    this.userWon = snapshot.userWon;
    this.userLost = snapshot.userLost;
    this.transactions = structuredClone(snapshot.transactions);
    this.nextEntityId = snapshot.nextEntityId;
    this.rng = seedrandom("restored", {
      state: snapshot.rngState as seedrandom.State.Arc4,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // -- internals -----------------------------------------------------------

  private requireInput(): CreateEpisodeInput {
    // Mirrors the real worker-backed engine: once closed, no further calls can
    // succeed. DomainService must never rely on reading an ended episode's
    // engine after dispose() -- see EpisodeRecord.finalRawState.
    if (this.closed) throw new Error("Fake engine has been closed");
    if (!this.input) throw new Error("Fake engine has not been initialized");
    return this.input;
  }

  private generatePlayer(role: PlayerSummary["role"]): PlayerSummary {
    return {
      pid: this.nextEntityId++,
      name: `Player ${this.nextEntityId}`,
      age: 20 + Math.floor(this.rng() * 15),
      position:
        ["PG", "SG", "SF", "PF", "C"][Math.floor(this.rng() * 5)] ?? "G",
      overall: 40 + Math.floor(this.rng() * 40),
      potential: 45 + Math.floor(this.rng() * 45),
      contractAmount: 1 + Math.floor(this.rng() * 25),
      contractExpires: this.season + 1 + Math.floor(this.rng() * 4),
      injuryGamesRemaining: 0,
      role,
      rosterOrder: 0,
    };
  }

  private generateProspect(): ProspectSummary {
    return {
      pid: this.nextEntityId++,
      name: `Prospect ${this.nextEntityId}`,
      age: 19 + Math.floor(this.rng() * 3),
      position:
        ["PG", "SG", "SF", "PF", "C"][Math.floor(this.rng() * 5)] ?? "G",
      scoutedOverall: 35 + Math.floor(this.rng() * 30),
      scoutedPotential: 50 + Math.floor(this.rng() * 45),
      draftYear: this.season,
    };
  }

  private recordTransaction(
    type: TransactionRecord["type"],
    description: string,
    teamIds: number[],
  ): void {
    this.transactions.push({
      transactionId: this.nextEntityId++,
      season: this.season,
      day: this.day,
      type,
      description,
      teamIds,
    });
  }

  private isBlocked(): boolean {
    return this.phase === "draft" && this.pendingDraftPicksThisSeason > 0;
  }

  private nextDecision(): string {
    if (
      this.phase === "regular_season" &&
      this.gamesPlayedThisSeason < SEASON_GAMES
    )
      return "play_next_game";
    if (
      this.phase === "playoffs" &&
      this.playoffGamesPlayed < this.playoffGamesTarget
    )
      return "play_next_game";
    if (this.phase === "draft" && this.pendingDraftPicksThisSeason > 0)
      return "make_draft_pick";
    return "advance_phase";
  }

  private legalActionCategories(): string[] {
    const categories = [
      "advance",
      "evaluate_trade",
      "get_state",
      "get_options",
      "checkpoint",
    ];
    if (this.phase !== "draft")
      categories.push(
        "execute_trade",
        "set_lineup",
        "release_player",
        "negotiate_contract",
        "sign_free_agent",
      );
    if (this.phase === "draft" && this.pendingDraftPicksThisSeason > 0)
      categories.push("make_draft_pick");
    return categories;
  }

  private computeStandings(userTeamId: number) {
    const all = [
      {
        tid: userTeamId,
        name: "Research Test Team",
        abbrev: "RES",
        won: this.userWon,
        lost: this.userLost,
      },
      ...this.opponentStandings.map((team, index) => ({
        tid: team.tid,
        name: `Rival ${index + 1}`,
        abbrev: `RV${index + 1}`,
        won: team.won,
        lost: team.lost,
      })),
    ];
    const sorted = [...all].sort((a, b) => b.won - b.lost - (a.won - a.lost));
    return sorted.map((team, index) => ({
      tid: team.tid,
      name: team.name,
      abbrev: team.abbrev,
      won: team.won,
      lost: team.lost,
      conference: "Research",
      division: "Sandbox",
      rank: index + 1,
      gamesBehind: sorted[0]
        ? (sorted[0].won - sorted[0].lost - (team.won - team.lost)) / 2
        : 0,
    }));
  }

  private computeSchedule() {
    return Array.from(
      { length: Math.max(0, SEASON_GAMES - this.gamesPlayedThisSeason) },
      (_, index) => ({
        gid: this.gamesPlayedThisSeason + index + 1,
        season: this.season,
        day: this.day + index + 1,
        homeTeamId: this.requireInput().userTeamId,
        awayTeamId:
          OPPONENT_TIDS[index % OPPONENT_TIDS.length] ?? OPPONENT_TIDS[0]!,
        played: false,
      }),
    );
  }

  private stepOneDay(): EngineEvent[] {
    this.day += 1;
    switch (this.phase) {
      case "preseason": {
        this.phase = "regular_season";
        this.gamesPlayedThisSeason = 0;
        return [{ type: "phase_change", phase: this.phase }];
      }
      case "regular_season": {
        if (this.gamesPlayedThisSeason >= SEASON_GAMES) {
          this.phase = "playoffs";
          const standings = this.computeStandings(
            this.requireInput().userTeamId,
          );
          const userStanding = standings.find(
            (team) => team.tid === this.requireInput().userTeamId,
          );
          this.playoffGamesPlayed = 0;
          this.playoffGamesTarget =
            userStanding && userStanding.rank <= 3 ? PLAYOFF_GAMES : 0;
          return [{ type: "phase_change", phase: this.phase }];
        }
        const won = this.rng() >= 0.48;
        this.gamesPlayedThisSeason += 1;
        if (won) this.userWon += 1;
        else this.userLost += 1;
        for (const opponent of this.opponentStandings) {
          if (this.rng() >= 0.5) opponent.won += 1;
          else opponent.lost += 1;
        }
        return [
          {
            type: "game",
            game: this.gamesPlayedThisSeason,
            result: won ? "win" : "loss",
          },
        ];
      }
      case "playoffs": {
        if (this.playoffGamesPlayed >= this.playoffGamesTarget) {
          this.phase = "draft_lottery";
          return [{ type: "phase_change", phase: this.phase }];
        }
        const won = this.rng() >= 0.5;
        this.playoffGamesPlayed += 1;
        if (won) this.userWon += 1;
        else this.userLost += 1;
        return [
          {
            type: "game",
            game: this.playoffGamesPlayed,
            result: won ? "win" : "loss",
            playoff: true,
          },
        ];
      }
      case "draft_lottery": {
        this.phase = "draft";
        this.draftProspects = Array.from({ length: 10 }, () =>
          this.generateProspect(),
        );
        this.pendingDraftPicksThisSeason = Math.min(this.ownedPicks.length, 2);
        return [{ type: "phase_change", phase: this.phase }];
      }
      case "draft": {
        this.phase = "resigning";
        return [{ type: "phase_change", phase: this.phase }];
      }
      case "resigning": {
        this.phase = "free_agency";
        return [{ type: "phase_change", phase: this.phase }];
      }
      case "free_agency": {
        this.phase = "preseason";
        this.season += 1;
        return [
          { type: "phase_change", phase: this.phase, season: this.season },
        ];
      }
    }
  }
}
