/**
 * Does the asset-value formula measure future value?
 *
 * Current formula: overall * 2 + potential (src/research/metrics.ts).
 * For an older player potential collapses toward overall, so the formula
 * approaches 3 * overall -- it rewards present ability and is blind to age.
 * This dumps a real roster so the skew can be read directly.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DomainService } from "../src/domain/DomainService.js";
import { BasketballGmEngine } from "../src/engine/bbgm/BasketballGmEngine.js";
import { EpisodeManager } from "../src/sessions/EpisodeManager.js";
import { createFileSnapshotStore } from "../src/persistence/snapshots.js";
import type { RosterView } from "../src/domain/types.js";

const SEED = process.env["PROBE_SEED"] ?? "grant-seed-001";
const current = (p: { overall: number; potential: number }): number =>
  p.overall * 2 + p.potential;
const avg = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const main = async (): Promise<void> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "asset-formula-"));
  const episodes = new EpisodeManager(() => new BasketballGmEngine(), dataRoot);
  const domain = new DomainService(episodes, createFileSnapshotStore(dataRoot));
  const overview = await domain.createEpisode({
    scenarioId: "asset-formula-probe",
    seed: SEED,
    userTeamId: 0,
    startingSeason: 2026,
  });
  const roster = (await domain.getState({
    episodeId: overview.episodeId,
    view: "roster",
    limit: 50,
  })) as RosterView;

  const rows = [...roster.players].sort((a, b) => current(b) - current(a));
  process.stdout.write("rank  age  ovr  pot   formula   gap(pot-ovr)\n");
  for (const [i, p] of rows.entries()) {
    process.stdout.write(
      `${String(i + 1).padStart(4)}  ${String(p.age).padStart(3)}  ${String(p.overall).padStart(3)}  ${String(p.potential).padStart(3)}   ${String(current(p)).padStart(5)}   ${String(p.potential - p.overall).padStart(5)}\n`,
    );
  }

  const old = rows.filter((p) => p.age >= 30);
  const young = rows.filter((p) => p.age <= 23);
  process.stdout.write(
    `\nage>=30: n=${old.length} avgFormula=${avg(old.map(current)).toFixed(1)} avgGap=${avg(old.map((p) => p.potential - p.overall)).toFixed(1)}\n`,
  );
  process.stdout.write(
    `age<=23: n=${young.length} avgFormula=${avg(young.map(current)).toFixed(1)} avgGap=${avg(young.map((p) => p.potential - p.overall)).toFixed(1)}\n`,
  );
  process.stdout.write(
    `roster=${rows.length}  SUM=${rows.reduce((s, p) => s + current(p), 0)}  MEAN=${avg(rows.map(current)).toFixed(1)}\n`,
  );
  await domain.endEpisode(overview.episodeId).catch(() => undefined);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
