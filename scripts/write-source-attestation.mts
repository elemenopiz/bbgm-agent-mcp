#!/usr/bin/env -S node --experimental-strip-types

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { BASKETBALL_GM_ENGINE_METADATA } from "../src/engine/bbgm/BasketballGmEngine.js";

const root = resolve(import.meta.dirname, "..");
const SOURCE_ROOTS = [
  "src",
  "engine-bridge",
  "scripts",
  "experiments",
  "scenarios",
  "docs",
  "package.json",
  "pnpm-lock.yaml",
  "bbgm-engine.lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  ".nvmrc",
];

type AttestedFile = { path: string; bytes: number; sha256: string };

const digest = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const commandOutput = (command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
};

const collectFiles = async (path: string): Promise<string[]> => {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".data") continue;
    files.push(...(await collectFiles(resolve(path, entry.name))));
  }
  return files;
};

const attestFiles = async (): Promise<AttestedFile[]> => {
  const paths = (
    await Promise.all(
      SOURCE_ROOTS.map((entry) => collectFiles(resolve(root, entry))),
    )
  ).flat();
  const files = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      const content = await readFile(path);
      return {
        path: relative(root, path),
        bytes: content.byteLength,
        sha256: digest(content),
      };
    }),
  );
  return files.sort((a, b) => a.path.localeCompare(b.path));
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      out: {
        type: "string",
        default: ".data/evidence-bundle/source-attestation.json",
      },
      "artifact-root": { type: "string", multiple: true },
    },
    strict: true,
  });
  const files = await attestFiles();
  const gitStatus = commandOutput("git", ["status", "--porcelain"]);
  const gitDiff = commandOutput("git", ["diff", "--binary", "HEAD"]);
  const artifactRoots = (values["artifact-root"] ?? []).map((path) =>
    resolve(root, path),
  );
  const output = {
    schemaVersion: "source-attestation.v1",
    generatedAt: new Date().toISOString(),
    repositoryRoot: root,
    provenance: {
      gitCommit: commandOutput("git", ["rev-parse", "HEAD"]),
      workingTreeClean: gitStatus.length === 0,
      gitStatus,
      gitDiffSha256: digest(gitDiff),
      nodeVersion: process.version,
      pnpmVersion: commandOutput("pnpm", ["--version"]),
      engine: BASKETBALL_GM_ENGINE_METADATA,
      sourceTreeSha256: digest(JSON.stringify(files)),
    },
    files,
    artifactRoots: artifactRoots.map((path) => relative(root, path)),
    reproduction: {
      install: "corepack pnpm install --frozen-lockfile",
      verifyEngine:
        "BBGM_SOURCE_DIR=/absolute/path/to/zengm corepack pnpm engine:verify",
      check: "corepack pnpm check",
      baseline:
        "BBGM_SOURCE_DIR=/absolute/path/to/zengm node scripts/run-grant-demo.mts --data-root .data/grant-demo-reproduction --out .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json --summary-out .data/grant-demo-reproduction/reviewer-summary.md",
    },
  };
  const outputPath = resolve(
    root,
    values.out ?? ".data/evidence-bundle/source-attestation.json",
  );
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.error(`source-attestation: wrote ${outputPath}`);
};

try {
  await main();
} catch (error: unknown) {
  console.error(
    `source-attestation: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
