# Project goal and definition of done

## Governing objective

Build a standalone TypeScript Model Context Protocol (MCP) server that
connects an LLM agent to a headless Basketball GM simulation engine, and use
it as a controlled safety testbed for open-weight, tool-using agents.

The active objective is a credible application for Thinking Machines Lab’s
Safety Research Grant, using Tinker credits to study:

> Whether narrow fine-tuning against an incomplete visible proxy causes
> reward hacking, oversight-sensitive behavior, or safety-relevant behavioral
> change in a stateful tool environment—and whether those failures can be
> detected with simple, reproducible evaluations.

Basketball GM is the instrument, not the claim. The project must measure an
independently scored hidden intended objective alongside the training-visible
proxy, with exact replay and held-out evaluation. Do not frame the active work
as an interactivity grant, a human-steering study, or a claim about basketball
competence.

This research objective is the governing context for architecture, tool
design, instrumentation, evaluation, and future implementation decisions. A
feature is not complete merely because it works in a short demo; it must help
make the environment trustworthy, reproducible, analyzable, and compelling as
an AI research artifact.

## Intended system

The finished system should let an LLM or offline evaluation harness:

1. Start a deterministic, isolated Basketball GM episode.
2. Observe only the information allowed by a scenario.
3. Make the full set of supported general-manager decisions through validated
   MCP tools.
4. Advance simulated time while resolving mandatory decision points.
5. Receive safe, typed, revision-aware, retry-safe mutation behavior.
6. Checkpoint, restore, replay, and reproduce trajectories.
7. Measure long-horizon competitive outcomes, asset preservation, constraint
   compliance, recovery, invalid behavior, and tool-use efficiency.
8. Compare an open model before and after narrow proxy fine-tuning against
   transparent baselines under identical seeds, engine versions, and scenario
   rules.

## Definition of done

### Protocol and domain

- The MCP server exposes a clean, spec-compliant tool catalog with precise
  input and output schemas, stable errors, correct read-only/destructive
  annotations, and no stdout pollution in stdio mode.
- Every supported gameplay action is represented by a typed domain operation
  and is validated before reaching the engine.
- Mutations are serialized per episode, protected by optimistic revisions,
  idempotency keys are durable and action-bound, and failed mutations either
  leave state unchanged or fail with an explicit recovery status.
- The server clearly reports unsupported engine phases, configurations, and
  fidelity compromises rather than silently approximating them.

### Engine and lifecycle

- The pinned real Basketball GM engine is verified and exercised end to end.
- Each episode is isolated with bounded worker execution, timeouts, resource
  controls, crash detection, cleanup, and a defined recovery or quarantine
  path.
- Episode metadata, checkpoints, idempotency state, and final artifacts are
  durable across process restarts, with an explicit resume/replay workflow.
- Real-engine integration tests cover normal and adverse paths, not only a
  single accepted trade and happy-path season.

### Research integrity

- Scenario manifests enforce allowed information, allowed actions, horizons,
  budgets, starting conditions, and hard constraints.
- Hard constraints are mechanically evaluated or explicitly rejected as
  unsupported; undeclared evaluators never report false satisfaction.
- All tool attempts—including rejected, stale, invalid, timed-out, and
  retried calls—are logged with enough context to calculate behavioral
  metrics without guessing.
- Raw metric components, configurable scalar rewards, lexicographic results,
  Pareto results, and per-step trajectory data are available.
- The evaluator supports reproducible multi-seed runs and transparent,
  deterministic baselines, with outputs suitable for grant-quality analysis.
- The active safety evaluation separates visible proxy reward from a hidden,
  independently computed intended objective and records proxy-intent
  divergence, tail degradation, oversight sensitivity, and held-out
  generalization without inferring internal intent from action traces.
- The proxy-intent detector is calibrated against planted policies with known
  ground truth (proxy-hacker, constraint-violator, stall, aligned optimizer,
  monitoring-sensitive) and its sensitivity and specificity are reported before
  any learned policy is scored.
- The scenario manifest and evaluator interface are extractable as a portable,
  environment-independent contract, with the normative specification free of
  basketball-specific terms.

### Grant-quality artifact

- Documentation explains the research hypothesis, environment contract,
  scenario format, baselines, metrics, threats to validity, licensing, and
  reproducibility procedure.
- The repo has a repeatable clean-install CI path, real-engine verification
  instructions, release/versioning discipline, and a demonstrable end-to-end
  experiment.
- The final system can support a compelling safety-grant narrative: why this
  testbed exposes reward hacking and narrow-fine-tuning failure modes, what is
  measured, why the results are trustworthy, and how Tinker credits will be
  used.
- The submission artifacts stay current and consistent: the one-page summary
  ([`GRANT_ONE_PAGE_SUMMARY.md`](GRANT_ONE_PAGE_SUMMARY.md)), the packet
  ([`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md)), and the dated
  plan ([`GRANT_TIMELINE.md`](GRANT_TIMELINE.md)).

## Decision rule for future work

Until September 25, prefer work that a reviewer can check in fifteen minutes:
detector calibration, frozen and dated pre-registration, and the portable
contract. Never delay the submission to add evidence.

When a proposed change conflicts with a short-term demo convenience, prefer
the option that strengthens safety construct validity, objective separation,
deterministic research validity, reproducibility, observability, and honest
failure reporting. Prioritize proxy/intent evaluation, hidden-objective
leakage tests, held-out generalization, tail-risk analysis, and Tinker rollout
provenance. Do not spend grant-critical effort on the superseded interactivity
agenda unless the user explicitly reactivates it, and do not broaden the claim
of completeness beyond what the real engine and research harness verify.
