#!/usr/bin/env -S node --experimental-strip-types

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const main = async (): Promise<void> => {
  const path = resolve(
    root,
    process.argv[2] ?? ".data/meaningful-demo/decision-timeline.json",
  );
  const artifact = JSON.parse(await readFile(path, "utf8")) as {
    schemaVersion?: unknown;
    timeline?: {
      label?: unknown;
      action?: Record<string, unknown>;
      details?: Record<string, unknown>;
      before?: { revision?: unknown; stateHash?: unknown };
      after?: { revision?: unknown; stateHash?: unknown };
    }[];
    terminalMetrics?: { hardConstraintViolations?: unknown };
  };
  if (artifact.schemaVersion !== "meaningful-demo.v1") {
    throw new Error("unexpected meaningful-demo schema version");
  }
  const timeline = artifact.timeline ?? [];
  const labels = new Set(timeline.map((entry) => entry.label));
  for (const required of [
    "evaluate_and_execute_accepted_trade",
    "advance_to_trade_deadline",
    "make_draft_pick",
    "restore_pre_draft_checkpoint",
    "make_replayed_draft_pick",
  ]) {
    if (!labels.has(required))
      throw new Error(`missing demo event ${required}`);
  }
  const trade = timeline.find(
    (entry) => entry.label === "evaluate_and_execute_accepted_trade",
  );
  const evaluation = trade?.details?.["evaluation"];
  if (
    typeof evaluation !== "object" ||
    evaluation === null ||
    (evaluation as Record<string, unknown>)["acceptedByOtherTeam"] !== true
  ) {
    throw new Error("demo trade was not accepted by the pinned engine");
  }
  let previousAfter: { revision?: unknown; stateHash?: unknown } | undefined;
  for (const [index, entry] of timeline.entries()) {
    const before = entry.before;
    const after = entry.after;
    if (after !== undefined) {
      if (
        typeof after.stateHash !== "string" ||
        after.stateHash.length !== 64
      ) {
        throw new Error(
          `timeline entry ${index} has an invalid after state hash`,
        );
      }
      if (previousAfter !== undefined && before !== undefined) {
        if (before.stateHash !== previousAfter.stateHash) {
          throw new Error(
            `timeline entry ${index} breaks the state-hash chain`,
          );
        }
        if (
          typeof before.revision !== "number" ||
          typeof after.revision !== "number" ||
          after.revision !== before.revision + 1
        ) {
          throw new Error(
            `timeline entry ${index} is not an audited one-revision transition`,
          );
        }
      }
      previousAfter = after;
    }
    if (
      entry.label === "create_initial_checkpoint" ||
      entry.label === "create_pre_draft_checkpoint"
    ) {
      const checkpointHash = entry.details?.["stateHash"];
      if (checkpointHash !== previousAfter?.stateHash) {
        throw new Error(
          `checkpoint at timeline entry ${index} is not bound to the current state hash`,
        );
      }
    }
  }
  const finalState = artifact as unknown as {
    finalState?: { stateHash?: unknown };
  };
  if (finalState.finalState?.stateHash !== previousAfter?.stateHash) {
    throw new Error("final state hash is not the terminal timeline hash");
  }
  const firstPick = timeline.find((entry) => entry.label === "make_draft_pick");
  const replayedPick = timeline.find(
    (entry) => entry.label === "make_replayed_draft_pick",
  );
  const firstPid = firstPick?.action?.["pid"];
  const replayedPid = replayedPick?.action?.["pid"];
  if (firstPid !== replayedPid) {
    throw new Error("checkpoint restore did not reproduce the draft prospect");
  }
  if (artifact.terminalMetrics?.hardConstraintViolations !== 0) {
    throw new Error("meaningful demo ended with hard constraint violations");
  }

  const episodeId = (artifact as { episodeId?: unknown }).episodeId;
  const dataRoot = (artifact as { dataRoot?: unknown }).dataRoot;
  if (typeof episodeId !== "string" || typeof dataRoot !== "string") {
    throw new Error("meaningful demo must declare episodeId and dataRoot");
  }
  const episodeEntries = (
    await readdir(join(dataRoot, "episodes"), {
      withFileTypes: true,
    })
  ).filter((entry) => entry.isDirectory());
  if (episodeEntries.length !== 1 || episodeEntries[0]?.name !== episodeId) {
    throw new Error(
      `meaningful demo data root must contain exactly the referenced episode (${episodeId})`,
    );
  }
  const episodeRoot = join(dataRoot, "episodes", episodeId);
  const metadata = JSON.parse(
    await readFile(join(episodeRoot, "metadata.json"), "utf8"),
  ) as { episodeId?: unknown; status?: unknown };
  if (metadata.episodeId !== episodeId || metadata.status !== "ended") {
    throw new Error(
      "referenced meaningful-demo metadata is not ended or mismatched",
    );
  }
  const trajectory = (
    await readFile(join(episodeRoot, "trajectory.jsonl"), "utf8")
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          episodeId?: unknown;
          postStateHash?: unknown;
          step?: unknown;
        },
    );
  if (
    trajectory.length === 0 ||
    trajectory.some((record) => record.episodeId !== episodeId) ||
    trajectory[0]?.step !== "create_episode" ||
    trajectory.at(-1)?.step !== "end_episode"
  ) {
    throw new Error("referenced meaningful-demo trajectory is invalid");
  }
  const trajectoryHashes = new Set(
    trajectory
      .map((record) => record.postStateHash)
      .filter((hash): hash is string => typeof hash === "string"),
  );
  for (const [index, entry] of timeline.entries()) {
    const timelineHash = entry.after?.stateHash;
    if (
      typeof timelineHash === "string" &&
      !trajectoryHashes.has(timelineHash)
    ) {
      throw new Error(
        `timeline entry ${index} state hash is absent from the referenced trajectory`,
      );
    }
  }
  if (trajectory.at(-1)?.postStateHash !== finalState.finalState?.stateHash) {
    throw new Error(
      "referenced trajectory does not end at finalState.stateHash",
    );
  }
  console.error(
    `meaningful-demo: verified ${timeline.length} timeline entries, accepted trade, deadline crossing, checkpoint restore, deterministic draft re-pick, and zero hard violations`,
  );
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `meaningful-demo: verification FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
