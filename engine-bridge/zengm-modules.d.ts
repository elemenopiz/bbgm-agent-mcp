/**
 * Ambient module shim for entry.ts's `"../src/..."` dynamic imports of the
 * pinned zengm checkout (BBGM_SOURCE_DIR). This repo has no compile-time
 * dependency on that checkout -- it is a separately-supplied local clone at
 * a path only known at runtime (see docs/ENGINE_INTEGRATION.md and
 * bbgm-engine.lock.json), never installed as a package here. Those import
 * specifiers are only ever resolved for real after
 * scripts/build-engine-bridge.ts copies entry.ts into
 * `<BBGM_SOURCE_DIR>/.mcp-bridge/`, one directory level inside the actual
 * checkout, and bundles it there with zengm's own rolldown.
 *
 * Without this shim, `tsc --noEmit` on this repo alone would report every
 * such import as "Cannot find module" -- true in this repo's own file tree,
 * but not a real problem: the paths are real at the pinned commit (verified
 * by hand while writing adapter.ts/entry.ts; see compatibility.ts), just
 * not resolvable without the checkout present. This is the project's one
 * narrow, documented `any`-typed compatibility-boundary exception (rule 5)
 * for that specific, unavoidable gap -- entry.ts is not part of any other
 * file's type-checked surface, so the loss of type safety is fully
 * contained to this one bundler-only entry point.
 */
declare module "../src/*";
