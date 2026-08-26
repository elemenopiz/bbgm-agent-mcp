# BBGM Agent MCP

An experimental Model Context Protocol server for studying long-horizon planning
and constraint compliance in a headless Basketball GM environment.

## Status

The protocol/domain vertical slice is operational with an explicit deterministic
demo engine. The real Basketball GM checkout is pinned and verified locally; the
headless compatibility bridge is under active implementation. Production does
not silently fall back to the demo engine.

## Requirements

- Node.js 24
- pnpm 11
- A separately obtained Basketball GM checkout for the real engine

```sh
nvm use
corepack pnpm install
corepack pnpm check
```

The real engine defaults to `.cache/zengm`, or set `BBGM_SOURCE_DIR` to another
local checkout. Verify it with:

```sh
pnpm engine:verify
```

## Development-only MCP server

```sh
BBGM_ENGINE=demo pnpm dev
```

The demo engine exists for protocol and orchestration tests only. Starting the
CLI without `BBGM_ENGINE=demo` fails closed until the real bridge is ready.

## Licensing

The adapter and research code are independent work. Basketball GM is a separate,
source-available dependency with additional restrictions. See
[THIRD_PARTY.md](THIRD_PARTY.md).

