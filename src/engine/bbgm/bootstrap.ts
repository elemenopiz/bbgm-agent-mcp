import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Installs the browser-like globals that Basketball GM's client bundle
 * expects, so it can run inside a plain Node worker thread instead of a
 * browser tab or the game's own dedicated Web Worker. Must be called before
 * anything from the zengm checkout is imported.
 *
 * This is the one place in the adapter boundary that reaches for loose
 * typing / narrow casts on purpose (see the inline comments below) -- it is
 * patching global objects to satisfy code we don't control, not modeling
 * our own domain.
 */
export async function installWorkerGlobals(sourceDir: string): Promise<void> {
  // Basketball GM persists league data to IndexedDB. Node has no native
  // IndexedDB, so fake-indexeddb provides an in-memory implementation and
  // installs itself on globalThis as a side effect of this import.
  //
  // NOTE for the lead session: "fake-indexeddb" is imported here (and,
  // today, directly by engine-bridge/entry.ts) but is NOT listed in this
  // repo's package.json/pnpm-lock.yaml. It needs to be added as a real
  // dependency (not devDependency -- it is required at runtime inside the
  // episode worker) before `pnpm install` will make it resolvable.
  await import("fake-indexeddb/auto");

  // The client bundle checks `typeof self`/`typeof window` in a few places
  // and calls addEventListener/postMessage as if it were running inside a
  // Web Worker (which is how it runs in the browser). None of these need to
  // do anything real for a headless run; they only need to exist so those
  // code paths don't throw.
  Object.assign(globalThis, {
    self: globalThis,
    window: globalThis,
    location: { href: "http://localhost/", origin: "http://localhost" },
    addEventListener: () => {},
    postMessage: () => {},
  });

  // SPORT gates zengm's sportFunctions conditional-compilation plugin (see
  // scripts/build-engine-bridge.ts).
  //
  // NODE_ENV="test" (NOT "production" -- confirmed the hard way, see
  // compatibility.ts "toUI / cross-thread UI calls"): a lot of zengm's
  // worker code (toUI, updatePlayMenu, updateMeta, loadNames, ...) talks to
  // a companion "UI thread" over a promise-worker-bi postMessage RPC
  // channel and awaits its reply. In the browser/Electron build there
  // really is a UI thread on the other end; in this headless worker there
  // is none, so those awaits would hang forever. zengm's own source guards
  // every one of those call sites with `if (process.env.NODE_ENV ===
  // "test") return Promise.resolve(...)` / early-return, which is exactly
  // the escape hatch zengm's own test suite relies on to run its worker
  // code without a real UI -- so this project deliberately reuses it rather
  // than reimplementing a fake UI-thread RPC responder.
  process.env["SPORT"] = "basketball";
  process.env["NODE_ENV"] = "test";

  // Basketball GM's league-creation code fetches static data files (real
  // player ratings, name generators, etc.) with relative URLs like
  // "/gen/real-player-data.json" that assume a running dev server. Headless
  // we have no server, so this resolves those paths onto the pinned
  // checkout's `data/` directory on disk instead.
  //
  // Cast rationale: Node's global `fetch` type (from @types/node) includes
  // overloads and properties (e.g. `preconnect`) our minimal shim doesn't
  // implement, and never needs to -- this file's job is only to satisfy the
  // small subset of `fetch` that zengm's league-creation code actually
  // calls (a single string URL, no options). Narrowly scoped, documented
  // compatibility-boundary cast per project rule 5.
  globalThis.fetch = createSourceDirFetch(sourceDir) as unknown as typeof fetch;
}

/**
 * Builds a `fetch` replacement that serves Basketball GM's static data
 * files (real player ratings, generated names, etc.) from the pinned
 * checkout's `data/` directory instead of a network/dev-server.
 */
export function createSourceDirFetch(
  sourceDir: string,
): (input: string) => Promise<Response> {
  return async (input: string): Promise<Response> => {
    let filePath = input.replace("/gen/", "data/");
    if (filePath.endsWith("real-player-data.json")) {
      filePath = filePath.replace(".json", ".basketball.json");
    }
    return new Response(await readFile(resolve(sourceDir, filePath)));
  };
}

/**
 * Installs a small, fast, seeded xorshift32 PRNG as Math.random for this
 * worker/process. Basketball GM's simulation code calls Math.random
 * directly in many places (game sim, ratings generation, AI decisions,
 * etc.), so seeding it here -- once per worker, before `create()` -- is what
 * makes a single episode's simulation deterministic.
 *
 * Because every episode gets its own worker thread (see
 * EpisodeWorkerHost/entry.ts), and this function replaces the *global*
 * Math.random for that worker's process, one episode's randomness can never
 * leak into another's: there is no shared process, only a shared source
 * file.
 */
export type SeededRandomController = {
  readonly algorithm: "xorshift32-v1";
  getState(): number;
  setState(state: number): void;
};

export function installSeededRandom(seed: string): SeededRandomController {
  let state = hashSeedToUint32(seed);
  Math.random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return {
    algorithm: "xorshift32-v1",
    getState: () => state >>> 0,
    setState: (nextState: number) => {
      if (
        !Number.isSafeInteger(nextState) ||
        nextState <= 0 ||
        nextState > 0xffffffff
      ) {
        throw new Error(`Invalid xorshift32 state: ${String(nextState)}`);
      }
      state = nextState >>> 0;
    },
  };
}

/** FNV-1a-ish string hash, folded into a non-zero uint32 PRNG seed. */
function hashSeedToUint32(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}
