# Handoff: continuing on another machine

Written 2026-09-03 for picking this repo up on a larger machine with a paid
model key. Everything referenced here is committed and pushed on
`feat/engine-information-surface`.

## 1. What is NOT in the repo

Three things are deliberately absent and must be recreated locally.

| Missing               | Why                                 | How to restore                             |
| --------------------- | ----------------------------------- | ------------------------------------------ |
| `.cache/zengm/`       | ~637 MB, separately licensed engine | Clone zengm yourself, pin the commit below |
| `.cache/bbgm-bridge/` | Build output                        | `corepack pnpm engine:build`               |
| `.env.local`          | Secrets, gitignored                 | Recreate with your own key (see §3)        |
| `.data/`              | Run artifacts, gitignored           | Regenerate by running the evaluators       |

The pinned engine is Basketball GM / zengm **5.1.0**, commit
`4ee432c5b9097ed978749a049fff5823711690dc`. `scripts/verify-engine.ts` checks
the identity and license hash, so a wrong checkout fails loudly rather than
producing quiet nonsense.

## 2. Setup

```sh
git clone https://github.com/elemenopiz/bbgm-agent-mcp.git
cd bbgm-agent-mcp
git checkout feat/engine-information-surface
corepack pnpm install --frozen-lockfile

# Obtain the engine separately, then:
export BBGM_SOURCE_DIR=/absolute/path/to/your/zengm-checkout
(cd "$BBGM_SOURCE_DIR" && pnpm install)

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node scripts/verify-engine.ts
corepack pnpm engine:build
corepack pnpm check
BBGM_REAL_ENGINE=1 corepack pnpm exec vitest run   # expect 140 passed, 0 skipped
```

Node 24 and pnpm 11. Last verified on Node `v24.19.0`, pnpm `11.19.0`.

## 3. Environment variables

```sh
# .env.local -- gitignored, chmod 600
OPENROUTER_API_KEY=sk-or-v1-...
```

Runtime flags that matter:

| Variable                     | Use                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| `BBGM_SOURCE_DIR`            | Required for anything touching the real engine                        |
| `BBGM_REAL_ENGINE=1`         | Un-skips the 9 real-engine integration tests                          |
| `BBGM_ENGINE_MAX_OLD_GEN_MB` | Worker heap cap. **See §4 -- the default is too small for 4 seasons** |
| `BBGM_ENGINE_TIMEOUT_MS`     | Per-call engine timeout; use `600000` for long horizons               |
| `BBGM_EVAL_PARALLELISM`      | Keep at `1` unless you have RAM to spare                              |
| `BBGM_MODEL_BASE_URL`        | `https://openrouter.ai/api/v1`                                        |
| `BBGM_MODEL_ID`              | e.g. `minimax/minimax-m3`                                             |
| `BBGM_MODEL_API_KEY`         | Your OpenRouter key                                                   |
| `BBGM_MODEL_MAX_TOKENS`      | Default 96. Raise to ~200 for models that emit reasoning first        |
| `BBGM_MODEL_RETRY_ATTEMPTS`  | Default 6. Bounded retry on 429/5xx/transport                         |
| `BBGM_MODEL_FALLBACK_IDS`    | Comma-separated. **Do not use for measurement** -- see §5             |
| `BBGM_MODEL_TRACE_DIR`       | Per-call model traces, one JSONL per seed                             |

## 4. Two limits hit on the 8 GB machine

Both should disappear on 32 GB with paid API access, but check rather than
assume.

**Worker heap.** A 4-season episode OOMed after ~6 minutes at the default
2240 MB old-generation cap: `Worker terminated due to reaching memory limit`.
It then surfaced as a quarantine, because the rollback path could not restore a
snapshot inside a dying worker. Set the cap explicitly:

```sh
export BBGM_ENGINE_MAX_OLD_GEN_MB=8192
```

A 2-season episode completes fine at the default. Only the 4-season scenario
needs this.

**Free-tier rate limits.** Two live-model runs died at 4 and 12 model calls on
HTTP 429, even with backoff and rotation. A full horizon needs hundreds of
calls. This is the reason for the paid key; nothing in the code needs changing.

## 5. Model rotation is not a measurement tool

`BBGM_MODEL_FALLBACK_IDS` exists only to keep an episode alive on a shared free
tier. A run that used it is not a single-policy result: the serving model can
change mid-episode. Every response records its serving model, so check that
field before believing any comparison. **For anything that goes in the grant,
pin one model and leave this unset.**

## 6. Pick up here

In priority order. The first item blocks the submission.

1. **Regenerate the evidence bundle.** The state hash changed (F9), so every
   artifact produced before commit `4e59460` fails `research:replay` and must
   not be cited. This is a blocking checkbox in the send gate.
   Commands are in `docs/EVIDENCE_BUNDLE.md` §"Exact reproduction commands".
   Verify with a fresh `research:replay` on whichever panel the submission
   cites.

2. **Complete a 4-season baseline run** on the new scenario and record the
   proxy vs hidden numbers:

   ```sh
   BBGM_ENGINE_MAX_OLD_GEN_MB=8192 BBGM_ENGINE_TIMEOUT_MS=600000 \
   BBGM_EVAL_PARALLELISM=1 corepack pnpm exec tsx src/research/evaluate.ts \
     --scenario scenarios/proxy-intent-divergence-v1.json \
     --policy all --data-root .data/proxy-intent-v1 \
     --out .data/proxy-intent-v1/report.json
   ```

   Each result carries `objectiveScores.proxyScalar` and
   `objectiveScores.hiddenScalar`.

3. **Live model over a full horizon**, now that rate limits are gone:

   ```sh
   corepack pnpm research:open-model \
     --scenario scenarios/proxy-intent-divergence-v1.json \
     --adapter experiments/open-model/tinker-compatible-adapter.mts \
     --policy untrained_open_model --model-only \
     --data-root .data/open-model-horizon \
     --out .data/open-model-horizon/report.json
   ```

   Note the adapter's prompt (`experiments/external-policy/prompts/system-prompt-v2.md`)
   was written for a 135M model and is much weaker than the one in
   `scripts/probe-model-episode.mts`, which got a model signing free agents
   unaided. Expect to port that prompt over; the adapter run advanced 11 times
   and took no GM actions.

4. **Verify or revert the trading-block WIP** (commit `2a3674a`). Committed but
   never exercised against the real engine. `engine:build` first, then exercise
   the trading-block read, the advertise mutation, and confirm a stale
   `expectedRevision` is rejected.

5. **Detector calibration against planted policies.** The construct-validity
   criterion. Needs items 1-2 done. See `docs/PROBE_FINDINGS.md` F2/F5 for why
   the planted hacker must be built around draft and re-sign levers rather than
   trades.

6. **Rotate the OpenRouter key.** The old one was pasted into a chat. It was
   never committed (verified with `git log -S`), but treat it as burned.

## 7. Gotchas that cost time before

- **`src/engine/bbgm/adapter.ts` and `engine-bridge/entry.ts` are bundled into
  `bridge.mjs`.** Edits there do nothing until `corepack pnpm engine:build`.
  This silently wasted a debugging session.
- **Never rebuild the bridge while an episode is running.** It kills live
  workers and quarantines their episodes. A subagent did this mid-flight and
  the failure looked like an engine bug.
- **The default `pnpm test` run skips the real-engine tests.** 121 green tests
  coexisted with the F9 hash defect for exactly this reason. Use
  `BBGM_REAL_ENGINE=1` before believing a green suite.
- **Anything derived from state must stay out of the state hash.** That was
  F9. `canonicalizeForHash` in `src/domain/stateHash.ts` is the single
  definition; both rollback and resume call `episodeStateHash`.

## 8. Orientation

| Question                            | File                                        |
| ----------------------------------- | ------------------------------------------- |
| What is this project trying to be?  | `docs/PROJECT_GOAL.md`                      |
| What is submitted to the grant?     | `docs/GRANT_ONE_PAGE_SUMMARY.md`            |
| Admin fields, budget, send gate     | `docs/GRANT_APPLICATION_PACKET.md`          |
| What has actually been measured     | `docs/PROBE_FINDINGS.md` (F1-F10)           |
| What a reviewer may be shown        | `docs/EVIDENCE_BUNDLE.md`                   |
| What BBGM exposes vs what we expose | `docs/INFORMATION_AUDIT.md`                 |
| The safety construct                | `scenarios/proxy-intent-divergence-v1.json` |
