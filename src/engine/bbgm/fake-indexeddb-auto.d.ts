/**
 * fake-indexeddb ships real type declarations (auto.d.ts at its package
 * root, lib/*.d.ts for the rest), but its package.json "exports" map does
 * not expose a "types" condition for the "fake-indexeddb/auto" subpath
 * under NodeNext-style resolution the way this project's tsconfig.json
 * requires (moduleResolution: "NodeNext") -- only the ESM build
 * (auto/index.mjs) is resolved, with no matching declaration file. This is
 * a real, known packaging gap in the dependency itself, not a design
 * choice of this adapter.
 *
 * This ambient shim (typed as an untyped side-effect module, i.e. `any`)
 * lets `tsc --noEmit` check bootstrap.ts without that gap blocking the
 * whole program. It does not affect runtime behavior at all -- the real
 * module (and its real, correct runtime behavior) still loads normally.
 */
declare module "fake-indexeddb/auto";
