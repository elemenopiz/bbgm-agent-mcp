# Contributing

This is a single-maintainer research repository. The process below is kept
lightweight on purpose — enough structure to keep the codebase honest and
reproducible, not enough to slow down solo iteration.

## Dev environment setup

```sh
nvm use            # pins Node to the version in .nvmrc (24)
corepack enable     # if pnpm 11 isn't already on PATH
pnpm install
```

That's it for engine-independent work: domain logic, MCP tool wiring, the
research/evaluation layer, and unit/contract tests all run against
`FakeSimulationEngine` and need no Basketball GM checkout.

If you're working on `src/engine/` or anything that talks to the real
engine, you additionally need a Basketball GM / zengm checkout — see
[README.md](README.md#prerequisites) and [THIRD_PARTY.md](THIRD_PARTY.md)
before doing so; this wrapper deliberately does not fetch one for you.

## Workflow

There's no branch-protection ceremony here: work directly, commit in small
reviewable steps, and open a PR (or just push to `main`, if you're the sole
committer at the time) once a change is self-contained and passing checks.
If this ever grows beyond one active contributor, default to PRs against
`main` with at least one review before merge rather than direct pushes.

Before pushing or opening a PR, run:

```sh
pnpm check
```

`pnpm check` runs `format:check`, `lint`, `typecheck`, `test`, and `build` in
sequence, matching CI (see `.github/workflows/ci.yml`). Fix everything
locally; don't rely on CI to catch formatting, lint, or type errors.

## Code style

- **Formatting**: Prettier. Run `pnpm format` to fix, `pnpm format:check` to
  verify without writing (this is what CI runs).
- **Linting**: ESLint (flat config, `eslint.config.js`) with
  `@typescript-eslint`'s type-checked rule sets. Run `pnpm lint`. Notable
  rules enabled: no floating promises, no implicit `any`, consistent
  `import type` usage. This project prefers `type` over `interface` for
  object shapes (`consistent-type-definitions` is tuned accordingly, rather
  than left at the stricter-by-default `interface` preference).
- **TypeScript**: strict mode is non-negotiable (`strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`, ... — see `tsconfig.json`).
  Don't weaken these to make a change compile; fix the change instead.
- Never write to `stdout` from library code. The MCP server speaks
  JSON-RPC over stdio, so stdout is reserved exclusively for protocol
  frames. All logging goes through `src/logging/logger.ts`, which writes to
  stderr only — use it (or `console.error` in the rare case you're outside
  its reach, e.g. the engine bridge) instead of `console.log`.

## Test taxonomy

Tests live under `tests/`, split by what they exercise:

| Directory           | Scope                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit`        | Pure logic in isolation — invariants, normalization, state hashing, schema parsing, `DomainService` behavior against `FakeSimulationEngine` — with no real engine or spawned process                                           |
| `tests/contract`    | The MCP tool catalog's contract with clients: every tool advertises input/output schemas, annotations match kind (read-only vs. mutating), and stable `DomainErrorCode`s surface correctly through `isError` results           |
| `tests/determinism` | Same seed + same action sequence -> identical state-hash sequence; different seeds diverge; concurrent episodes never cross-contaminate                                                                                        |
| `tests/integration` | Multiple layers wired together in-process — the MCP server responding to actual tool calls over an in-memory transport, via `@modelcontextprotocol/client`'s `Client` + `InMemoryTransport`                                    |
| `tests/e2e`         | The actual compiled binary (`dist/cli.js`, never `tsx`), spawned as a real child process and driven over a real stdio transport — proves `tools/list`, schema advertisement, error handling, and stdout cleanliness end to end |
| `tests/fixtures`    | Shared test doubles and helpers, notably `FakeSimulationEngine` — never imported by production code (`src/`), only by tests                                                                                                    |

Run everything with:

```sh
pnpm test        # vitest run
pnpm test:watch  # vitest, watch mode
```

### Engine-dependent tests

Any test that needs the real engine (a `BasketballGmEngine` instance
talking to an actual zengm checkout) must be gated behind the
`BBGM_REAL_ENGINE=1` environment variable and skip by default, following the
existing pattern:

```ts
const runRealEngine = process.env["BBGM_REAL_ENGINE"] === "1";

describe.skipIf(!runRealEngine)("BasketballGmEngine", () => {
  test("does the real-engine thing", { timeout: 120_000 }, async () => {
    // ...
  });
});
```

These tests also need `BBGM_SOURCE_DIR` pointed at a verified checkout (see
README). They are never run in CI (no checkout is available there) — see
the comment in `.github/workflows/ci.yml`. Run them locally with:

```sh
BBGM_REAL_ENGINE=1 BBGM_SOURCE_DIR=/path/to/zengm pnpm test
```

Give these tests generous `timeout` values — real-engine operations
(league creation, playing a game) are far slower than the fake engine.

## Commit and PR conventions

- Commit messages: a short imperative summary line, optionally followed by
  a blank line and more detail. A loose conventional-commits style prefix
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`) is encouraged
  where it's unambiguous, but not enforced by tooling.
  Keep each commit focused on one logical change.
- PRs: describe _why_, not just _what_ — link back to the relevant part of
  the research brief or an issue if one exists. Include the output of
  `pnpm check` (or note that CI is green) before requesting review/merging.
- Don't mix formatting-only churn with behavioral changes in the same
  commit; run `pnpm format` as its own commit if a file needs a large
  reformat.
