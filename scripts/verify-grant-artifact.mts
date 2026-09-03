#!/usr/bin/env -S node --experimental-strip-types

import { resolve } from "node:path";
import { parseArgs } from "node:util";

// @ts-expect-error Node 24 executes this source TypeScript module directly.
import * as evidenceVerifier from "../src/research/evidenceVerifier.ts";

const { EvidenceVerificationError, verifyGrantArtifact } = evidenceVerifier;

const root = resolve(import.meta.dirname, "..");

const usage = (): void => {
  console.error(
    "Usage: node scripts/verify-grant-artifact.mts --report <path> --data-root <path>",
  );
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "data-root": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    usage();
    return;
  }
  if (!values.report || !values["data-root"]) {
    usage();
    process.exitCode = 2;
    return;
  }
  const result = await verifyGrantArtifact({
    reportPath: resolve(root, values.report),
    dataRoot: resolve(root, values["data-root"]),
  });
  console.log(
    `grant-evidence: verified ${result.checkedResults} result(s) across ${result.checkedEpisodes} episode(s); rollbackNodes=${result.rollbackNodes}`,
  );
};

try {
  await main();
} catch (error: unknown) {
  if (error instanceof EvidenceVerificationError) {
    console.error(`grant-evidence: FAILED: ${error.message}`);
    for (const issue of error.issues) {
      console.error(`- ${issue.path}: ${issue.message}`);
    }
  } else {
    console.error(
      `grant-evidence: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}
