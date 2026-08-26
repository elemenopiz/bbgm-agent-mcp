export const STATE_SCHEMA_VERSION = "1" as const;

export type EpisodeStatus = "active" | "ended";

export type PlayerSummary = {
  pid: number;
  name: string;
  age: number;
  position: string;
  overall: number;
  potential: number;
  contractAmount: number;
  contractExpires: number;
  injuryGamesRemaining: number;
};

export type ConstraintStatus = {
  code: string;
  satisfied: boolean;
  message: string;
};

export type LeagueState = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  episodeId: string;
  scenarioId: string;
  seed: string;
  engine: { name: string; version: string; commit?: string };
  status: EpisodeStatus;
  revision: number;
  stateHash: string;
  season: number;
  phase: string;
  userTeam: {
    tid: number;
    name: string;
    won: number;
    lost: number;
    payroll: number;
    salaryCap: number;
    capSpace: number;
  };
  roster: PlayerSummary[];
  constraints: ConstraintStatus[];
  legalActionCategories: string[];
  nextDecision: string;
};

export type CreateEpisodeInput = {
  episodeId: string;
  scenarioId: string;
  seed: string;
  userTeamId: number;
  startingSeason: number;
};

export type AdvanceInput = {
  target: "next_game" | "next_decision" | "games";
  count?: number;
};

export type MutationContext = {
  expectedRevision: number;
  idempotencyKey: string;
};

export type MutationResult = {
  episodeId: string;
  previousRevision: number;
  revision: number;
  stateHash: string;
  appliedAction: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  warnings: string[];
  nextDecision: string;
};

export type TradeAsset =
  | { type: "player"; pid: number }
  | { type: "draft_pick"; dpid: number };

export type TradeProposal = {
  otherTeamId: number;
  offered: TradeAsset[];
  requested: TradeAsset[];
};

export type TradeEvaluation = {
  legal: boolean;
  acceptedByOtherTeam: boolean | null;
  reasons: string[];
  payrollDelta: number;
  rosterSizeDelta: number;
};

export type Checkpoint = {
  checkpointId: string;
  episodeId: string;
  revision: number;
  stateHash: string;
  createdAt: string;
};

