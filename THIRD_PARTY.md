# Third-party software

## Basketball GM / zengm

This project integrates with a separately obtained source checkout of
[Basketball GM (zengm)](https://github.com/zengm-games/zengm), upstream
repository `https://github.com/zengm-games/zengm.git`.

**Basketball GM is Copyright (C) ZenGM, LLC. It is source-available, not
open source.** Its source license permits local private execution and
source sharing under its own terms, while restricting hosting of a running
instance and distribution of redistributable installers/builds. This
repository does not own, relicense, or grant you any rights to Basketball
GM. Read the upstream license before using the real engine:
<https://github.com/zengm-games/zengm/blob/master/LICENSE.md>

### Pinned version

The exact commit and version this wrapper is built and tested against are
recorded in [`bbgm-engine.lock.json`](bbgm-engine.lock.json) and verified at
build time by `scripts/verify-engine.ts` (`pnpm engine:verify`):

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Repository                | `https://github.com/zengm-games/zengm.git`                         |
| Commit                    | `4ee432c5b9097ed978749a049fff5823711690dc`                         |
| Package version           | `5.1.0`                                                            |
| Required Node             | 24                                                                 |
| Required pnpm             | 11                                                                 |
| Upstream license file     | `LICENSE.md`                                                       |
| Upstream license SHA-256  | `4b062aff490de1273782c6ab56839be01913690f494f0c95ac02bb07cb1f3603` |
| Integration patch version | `1`                                                                |

If you point `BBGM_SOURCE_DIR` at a checkout that doesn't match this commit,
package version, or license hash, `pnpm engine:verify` fails closed rather
than silently running against an unverified engine.

### What this repository does and does not vendor

This repository does **not** vendor, embed, or redistribute any Basketball
GM / zengm source code. It contains only the wrapper's own integration
code, which talks to a headless build of the engine over a message-passing
bridge running in a worker thread (`engine-bridge/entry.ts`,
`src/engine/bbgm/BasketballGmEngine.ts`).

The only place upstream-adjacent code is intended to live is a small,
auditable set of integration patches under `patches/zengm/` — small diffs
required to run the engine headlessly (e.g. stubbing browser globals), kept
separate from and clearly distinguishable from upstream source itself.
**As of this writing, `patches/zengm/` does not exist**: no patches have
been required yet. If patches are introduced later, they should remain
narrowly scoped, reviewable diffs, not copies of upstream files.

### Your obligations if you use the real engine

To run this wrapper against the real Basketball GM engine, you must:

1. Obtain your own checkout of the zengm repository yourself. This wrapper
   will not fetch, download, or install it for you — a deliberate design
   choice given the licensing terms above, not an oversight or missing
   feature.
2. Read and agree to the upstream `LICENSE.md` for that checkout. Your use
   of the engine is governed entirely by ZenGM, LLC's terms, independent of
   anything in this repository.
3. Not use this wrapper, or anything built with it, to host a
   publicly-reachable instance of Basketball GM, or to redistribute the
   engine or any build/installer derived from it, if that would violate the
   upstream license.

### Compatibility and distribution warning

This wrapper's own license ([LICENSE-WRAPPER.md](LICENSE-WRAPPER.md), MIT)
covers only the original code in this repository. It does not, and cannot,
override, extend, or relicense Basketball GM / zengm. If you redistribute
this wrapper, you are not thereby redistributing Basketball GM — but you
are also not granting your recipients any license to it. They must obtain
and license their own checkout exactly as described above.

## Other dependencies

Runtime and development dependencies (Zod, the `@modelcontextprotocol`
packages, `seedrandom`, TypeScript, Vitest, Prettier, and so on) are
standard open-source packages installed via `pnpm` and are covered by their
own respective licenses as declared in their published packages; see
`pnpm-lock.yaml` for the resolved set. None of them are Basketball GM /
zengm code and none of the restrictions above apply to them.
