import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDir = resolve(
  process.env["BBGM_SOURCE_DIR"] ?? resolve(root, ".cache/zengm"),
);
const generatedDir = resolve(sourceDir, ".mcp-bridge");
const outputDir = resolve(root, ".cache/bbgm-bridge");
await mkdir(generatedDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

// engine-bridge/entry.ts imports bootstrap.ts and adapter.ts from their real
// repo location (src/engine/bbgm/) using standard NodeNext ".js" specifiers,
// so `tsc --noEmit` can resolve and type-check them from within this repo
// like any other module. Neither that location nor those specifiers are
// reachable once entry.ts is physically copied into the zengm checkout's
// own `.mcp-bridge/` directory (a different filesystem location entirely,
// possibly on a different machine's disk layout), so this rewrites those
// two specifiers to flat-sibling ".ts" form as part of the copy, matching
// where bootstrap.ts/adapter.ts/mappings.ts are copied to below. adapter.ts
// and mappings.ts need no rewriting: adapter.ts's only runtime cross-file
// import is "./mappings.js" (already sibling-flat before AND after this
// copy), and mappings.ts has no runtime imports of its own -- see each
// file's module doc comment for why they were written to make this true.
const entrySource = await readFile(
  resolve(root, "engine-bridge/entry.ts"),
  "utf8",
);
const rewrittenEntrySource = entrySource
  .replace('"../src/engine/bbgm/bootstrap.js"', '"./bootstrap.ts"')
  .replace('"../src/engine/bbgm/adapter.js"', '"./adapter.ts"');
if (rewrittenEntrySource === entrySource) {
  throw new Error(
    "build-engine-bridge: expected import rewrite of engine-bridge/entry.ts had no effect -- " +
      "its bootstrap.ts/adapter.ts import specifiers may have changed; update this script to match.",
  );
}
await writeFile(resolve(generatedDir, "entry.ts"), rewrittenEntrySource);

await cp(
  resolve(root, "src/engine/bbgm/bootstrap.ts"),
  resolve(generatedDir, "bootstrap.ts"),
);
await cp(
  resolve(root, "src/engine/bbgm/adapter.ts"),
  resolve(generatedDir, "adapter.ts"),
);
await cp(
  resolve(root, "src/engine/bbgm/mappings.ts"),
  resolve(generatedDir, "mappings.ts"),
);

const rolldownModule = (await import(
  pathToFileURL(resolve(sourceDir, "node_modules/rolldown/dist/index.mjs")).href
)) as {
  rolldown: (
    options: Record<string, unknown>,
  ) => Promise<{ write: (options: Record<string, unknown>) => Promise<void> }>;
};
const pluginModule = (await import(
  pathToFileURL(
    resolve(sourceDir, "tools/lib/rolldownPlugins/sportFunctions.ts"),
  ).href
)) as {
  sportFunctions: (environment: "production", sport: "basketball") => unknown;
};

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
console.error(
  `Built Basketball GM bridge at ${resolve(outputDir, "bridge.mjs")}`,
);
