import { cp, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDir = resolve(process.env["BBGM_SOURCE_DIR"] ?? resolve(root, ".cache/zengm"));
const generatedDir = resolve(sourceDir, ".mcp-bridge");
const outputDir = resolve(root, ".cache/bbgm-bridge");
await mkdir(generatedDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
await cp(resolve(root, "engine-bridge/entry.ts"), resolve(generatedDir, "entry.ts"));

const rolldownModule = (await import(
  pathToFileURL(resolve(sourceDir, "node_modules/rolldown/dist/index.mjs")).href
)) as { rolldown: (options: Record<string, unknown>) => Promise<{ write: (options: Record<string, unknown>) => Promise<void> }> };
const pluginModule = (await import(
  pathToFileURL(resolve(sourceDir, "tools/lib/rolldownPlugins/sportFunctions.ts")).href
)) as { sportFunctions: (environment: "production", sport: "basketball") => unknown };

const bundle = await rolldownModule.rolldown({
  input: resolve(generatedDir, "entry.ts"),
  cwd: sourceDir,
  platform: "node",
  plugins: [pluginModule.sportFunctions("production", "basketball")],
});
await bundle.write({
  file: resolve(outputDir, "bridge.mjs"),
  format: "esm",
  sourcemap: true,
  codeSplitting: false,
});
console.error(`Built Basketball GM bridge at ${resolve(outputDir, "bridge.mjs")}`);
