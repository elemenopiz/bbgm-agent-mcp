import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

type EngineLock = {
  repository: string;
  commit: string;
  packageVersion: string;
  requiredNode: string;
  requiredPnpm: string;
  licenseFile: string;
  licenseSha256: string;
};

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(resolve(root, "bbgm-engine.lock.json"), "utf8")) as EngineLock;
const sourceDir = resolve(process.env["BBGM_SOURCE_DIR"] ?? resolve(root, ".cache/zengm"));

const actualCommit = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (actualCommit !== lock.commit) {
  throw new Error(`Basketball GM commit mismatch: expected ${lock.commit}, found ${actualCommit}`);
}

const packageJson = JSON.parse(await readFile(resolve(sourceDir, "package.json"), "utf8")) as {
  version?: string;
};
if (packageJson.version !== lock.packageVersion) {
  throw new Error(`Basketball GM package version mismatch: expected ${lock.packageVersion}, found ${packageJson.version}`);
}

const license = await readFile(resolve(sourceDir, lock.licenseFile));
const licenseHash = createHash("sha256").update(license).digest("hex");
if (licenseHash !== lock.licenseSha256) {
  throw new Error(`Basketball GM license hash mismatch: expected ${lock.licenseSha256}, found ${licenseHash}`);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== Number(lock.requiredNode)) {
  throw new Error(`Node ${lock.requiredNode} is required; running ${process.versions.node}`);
}

console.error(`Verified Basketball GM ${packageJson.version} at ${actualCommit}`);
console.error(`Source: ${sourceDir}`);
console.error(`License SHA-256: ${licenseHash}`);
