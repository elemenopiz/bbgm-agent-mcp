# Release and grant-evidence checklist

This is the release gate for the `bbgm-agent-mcp` research artifact. Current
label: **research-preview**. The repository contains environment and reference
policy machinery plus a bounded untrained open-model inference smoke; it does
not contain a Tinker-trained result or a validated long-horizon open-model
claim.

The active grant question is singular: does narrow Tinker fine-tuning on an
incomplete visible proxy increase proxy-success/intended-objective-failure,
oversight-sensitive behavior, or safety-relevant drift in the same open model
relative to its pre-training policy? Read `docs/SAFETY_GRANT_STRATEGY.md` for
the authoritative proposal frame and safety gates.

## 1. Scope and release boundary

- [ ] Confirm the candidate commit and review its complete diff.
- [ ] Confirm the release contains only wrapper, MCP, research, experiment,
      scenario, and allowed documentation content.
- [ ] Confirm no Basketball GM/zengm source, generated engine bundle, user
      save, or engine checkout is committed or packaged.
- [ ] Confirm the wrapper is not advertised as Basketball GM and is not
      presented as affiliated with or endorsed by ZenGM, LLC.
- [ ] Keep the label **research-preview** unless production requirements are
      separately met and documented.

Basketball GM is a separately obtained dependency under its own license. Read
`THIRD_PARTY.md` and the upstream license before running or sharing real-engine
artifacts. A wrapper release does not grant rights to the engine.

## 2. Clean-install and repository checks

Run from a fresh checkout of the candidate revision, without a local engine
checkout for the engine-independent checks:

```sh
node --version                 # Node 24 required by package.json/.nvmrc
corepack enable
pnpm --version                 # pnpm 11
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:contract
pnpm test:determinism
```

- [ ] Record Node, pnpm, operating system, git commit, and every result.
- [ ] Confirm frozen install does not modify the lockfile.
- [ ] Distinguish passed, skipped, and failed real-engine tests.
- [ ] Confirm stdio protocol framing stays on stdout and diagnostics on stderr.
- [ ] Confirm the build does not modify tracked files.

Hosted CI is engine-independent. A skipped real-engine test means the gate was
not run; it is not evidence that the real engine passed. The final release
transcript must record the result of each command; a skipped or dependency
install failure is not evidence of a passing gate.

## 3. Real-engine verification

Use a separately obtained checkout at the exact identity in
`bbgm-engine.lock.json`:

```sh
export BBGM_SOURCE_DIR=/absolute/path/to/your/pinned/zengm
corepack pnpm engine:verify
corepack pnpm engine:build
corepack pnpm engine:smoke
BBGM_REAL_ENGINE=1 BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm test:integration
```

- [ ] `engine:verify` passes commit, package version, license hash, and Node
      major checks.
- [ ] `engine:build` succeeds without copying upstream source into this repo.
- [ ] `engine:smoke` passes and its transcript is retained.
- [ ] Integration tests cover supported mutations, adverse rollback, episode
      isolation, and unsupported configuration rejection.
- [ ] Record engine version/commit, license hash, integration patch version,
      runtime, and exact output.
- [ ] Mark every real-engine check passed, failed, or skipped; never collapse
      those states into “tests passed.”

The current local engine identity check passes via
`BBGM_SOURCE_DIR=.cache/zengm node scripts/verify-engine.ts` for Basketball GM
5.1.0 at commit `4ee432c5b9097ed978749a049fff5823711690dc` and the locked
license hash. This does not substitute for the complete gate above.

## 4. Canonical baseline evidence

Generate into a new directory so historical data are not overwritten:

```sh
BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node scripts/run-grant-demo.mts \
  --data-root .data/grant-demo-reproduction \
  --out .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --summary-out .data/grant-demo-reproduction/reviewer-summary.md

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" node --experimental-strip-types \
  scripts/verify-grant-artifact.mts \
  --report .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-demo-reproduction

BBGM_SOURCE_DIR="$BBGM_SOURCE_DIR" corepack pnpm research:replay \
  --report .data/grant-demo-reproduction/long-horizon-asset-preservation-v1.json \
  --data-root .data/grant-demo-reproduction \
  --out .data/grant-demo-reproduction/replay-manifest.json
```

- [ ] Report contains exactly 10 reference results: two policies across five
      canonical seeds.
- [ ] Report records completion status separately from terminal metrics.
- [ ] Artifact verifier passes with no issues.
- [ ] Replay re-executes normalized actions and state hashes successfully.
- [ ] Raw trajectories, attempts, snapshots, metadata, summary, and command
      transcript travel with the report.

The current `.data/grant-ready-final-v9/` report is the verifier-passing pilot
candidate: it contains 10 results, heuristic completes 3/5 seeds, no_op stalls
5/5 at the mandatory draft boundary, and 17 refusal rollback events are
retained. Its replay manifest and source attestation are release gates; do not
replace it with historical `*-stats.json` derivatives.

## 5. Research-evidence gate

- [ ] Run the canonical two-season scenario with no_op and deterministic
      heuristic controls.
- [ ] Run the meaningful capability demo and verify its timeline separately.
- [ ] Run the bounded open-model smoke, or label the long-horizon open-model
      evaluation **not yet run**.
- [ ] Keep the same manifests, seed assignments, runtime, tool contract, and
      metric definitions across comparable policies.
- [ ] Report completion, wins, total/draft assets, hard constraints,
      invalid/stale actions, retries, rollback/recovery, and tool efficiency.
- [ ] Include raw metric components, not only scalar reward.
- [ ] For multi-seed claims, include sample count, mean, standard deviation,
      range, and the declared paired comparison method.
- [ ] Separate measured reference/inference evidence from proposed Tinker
      work.

The current open-model evidence is only
`.data/open-model-smoke-v4/`: three one-seed, three-step results using
untrained SmolLM2 inference plus matched controls. The model made two calls,
with one parse failure and one provider failure; no typed model action
executed. It is not a long-horizon result. The held-out control report is
`.data/grant-ready-heldout-v1/heldout-report.json` and covers the two frozen
held-out seeds. The built-in Basketball GM AI is not a current policy adapter
in this repository; do not list that comparison as completed.

The minimum honest current claim is: “This is a reproducible, instrumented
research environment with transparent reference baselines and a bounded
open-model inference boundary; Tinker training and long-horizon learned-agent
evaluation remain proposed work.”

## 6. Provenance and artifact hygiene

For every grant-facing run, preserve:

- [ ] wrapper version, git commit, working-tree status, Node/pnpm versions, and
      lockfile hash;
- [ ] engine lock identity when real-engine execution is used;
- [ ] exact scenario manifest, information/action policy, horizon, budget,
      constraints, objectives, reward mode, and seed set;
- [ ] policy/adapter/model/prompt/configuration identity and decoding settings;
- [ ] raw trajectories, attempts, state hashes, terminal metrics, rewards, and
      comparison output;
- [ ] evaluator-only reads and known fidelity caveats; and
- [ ] source attestation and exact command transcript.

The current source attestation is generated with:

```sh
corepack pnpm research:attest \
  --artifact-root .data/grant-ready-final-v9 \
  --artifact-root .data/grant-ready-heldout-v1 \
  --artifact-root .data/open-model-smoke-v4 \
  --artifact-root .data/meaningful-demo-v2
```

Before a tag, archive, or grant attachment:

```sh
git diff --check
git status --short --untracked-files=all
pnpm pack --dry-run
```

- [ ] No `.cache/`, `.data/`, `node_modules/`, credentials, private data,
      engine checkout, or generated bridge is in the release archive.
- [ ] Generated evidence is stored separately and its source revision/diff is
      recorded.
- [ ] Package contents and allowlist are reviewed after any hygiene change.

## 7. Tinker work gate

No item in this section is complete in the current repository:

- [ ] Add rollout tokens, masks, log-probabilities, rewards, and checkpoint
      lineage to the adapter.
- [ ] Record Tinker model/checkpoint, client/API version, sampler path,
      training configuration hash, and secrets-free manifest.
- [ ] Evaluate untrained and trained policies on the frozen three-seed
      development and two-seed held-out split with unchanged controls.
- [ ] Pre-register horizon completion as the primary outcome and competitive,
      asset, constraint, recovery, and efficiency metrics as secondary outcomes.
- [ ] Retain incomplete runs in intention-to-treat analysis and show
      completed-only summaries separately.
- [ ] Treat five-seed intervals/effect sizes as exploratory, not statistical
      validation of general planning.

A null or failed Tinker run is a valid research outcome if its provenance and
raw rollouts are retained; it is not evidence of improvement.

## 8. Final sign-off

- [ ] Every gate is complete or explicitly marked **not run**, **blocked**, or
      **pending**, with a reason and owner.
- [ ] No known verifier, replay, licensing, or reproducibility blocker is
      hidden by a green aggregate status.
- [ ] README/changelog wording matches collected evidence.
- [ ] The artifact remains labeled **research-preview**.
- [ ] A reviewer can distinguish wrapper behavior, real-engine behavior,
      deterministic baseline measurements, untrained inference, and proposed
      Tinker work.
