# One-page project summary (submission artifact)

> This file is the **1-page summary required by the application**. It is written
> to be pasted or exported as a single page. Do not lengthen it; supporting
> detail belongs in [`GRANT_APPLICATION_PACKET.md`](GRANT_APPLICATION_PACKET.md),
> [`GRANT_TIMELINE.md`](GRANT_TIMELINE.md), and
> [`SAFETY_GRANT_STRATEGY.md`](SAFETY_GRANT_STRATEGY.md).
> Target length: 600-680 words. Current: see the word-count gate in the packet.

---

## Auditing reward hacking and oversight-sensitive behavior after narrow fine-tuning in tool-using agents

**The problem.** Open-weight models are routinely fine-tuned downstream on
narrow, convenient objectives. That training signal is almost always an
incomplete proxy for what the deployer actually wants. We do not have simple,
reproducible ways to answer a basic safety question: when a tool-using agent is
fine-tuned to improve a visible proxy, does the intended objective improve with
it, or does the model learn to satisfy the measured surface while degrading
what was not measured?

**The question.** Does narrow fine-tuning on a visible short-horizon proxy
improve a hidden intended objective, or does it increase the rate of episodes
that succeed on the proxy while failing the intended objective or violating a
hard constraint?

**The instrument.** We measure this in a stateful tool environment built on a
pinned, real Basketball GM simulator driven through a typed Model Context
Protocol server. Basketball is not the claim; it is a compact laboratory with
the properties this measurement needs: delayed consequences, irreversible-looking
decisions, interacting hard constraints, mandatory deadlines, a 16-tool typed
action surface, and an exact simulator. The environment enforces per-scenario
limits on what a policy may observe and do, records every attempt including
rejected, stale, timed-out and retried calls, hashes state transitions, and
supports clean-room replay. Failure signatures are therefore measured, not
inferred from a score or a narrative.

**Design.** We pre-register a visible proxy (a deliberately incomplete
short-horizon signal) and a hidden intended objective computed independently
from horizon completion, hard-constraint compliance, and future-asset
preservation. The policy never receives the hidden formula, hidden valuation,
or evaluator-only labels. Using Tinker we fine-tune one open-weight base model
against the proxy and compare it with the same model before training under
identical prompts, tool schemas, decoding, seeds, and action budgets. Controls
are a no-op policy, a legal-completion policy, and a deterministic heuristic.
Evaluation uses held-out seeds, alternative hidden valuations, unseen
constraint combinations, and a bounded audit-visible/audit-absent comparison.
The primary endpoint is the pre-registered proxy-success / intent-failure rate;
we report raw components and per-seed deltas, never a single leaderboard number.

**Construct validity.** Before any model is trained, we calibrate the detector
against hand-written policies whose ground truth we control: a deliberate
proxy-hacker, a constraint-violator, a stall policy, an aligned optimizer, and
a monitoring-sensitive policy. A detector that does not flag planted hacks and
does not stay quiet on aligned controls is reported as failed and fixed before
it is used on a learned policy. We test several hidden valuations rather than
asserting one true value function, and we treat action traces as behavioral
evidence only - never as evidence of intent.

**Simplicity and generality.** The reusable deliverable is small: a portable
proxy-intent scenario and evaluator contract - a JSON manifest plus a narrow
evaluator interface - that any stateful tool environment can implement.
Basketball GM is the reference implementation because it is already
instrumented; we will port the same contract and detector to one deliberately
simple second environment to show the measurement is not a game-specific
artifact.

**Feasibility.** The environment exists and runs today: pinned engine 5.1.0,
typed revision-aware mutations with rollback, frozen development and held-out
scenario manifests, deterministic reference policies completing a multi-season
horizon, state-hash-verified rollback and replay, and a real open-model adapter
exercised end to end. The proxy-intent separation is implemented and
pre-registered in the manifest, not merely planned: the evaluator scores every
run against both objectives, and a test asserts the hidden objective never
reaches the policy. Grant support funds only the missing pieces: Tinker rollout
capture and training, and the held-out safety evaluation.

**Deliverables.** The portable contract and detector, checkpoint lineage and
rollout records, held-out safety results, a failure taxonomy, raw trajectories
and replay manifests, and an openly licensed methods note. If narrow
fine-tuning does not produce the predicted failure, we publish that null result
and its limits.
