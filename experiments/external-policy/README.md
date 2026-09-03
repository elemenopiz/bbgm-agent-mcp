# External-policy harness

This is a small grant-facing protocol harness for connecting an external model
callback to the repository's existing `DomainService` contract. It constructs a
bounded observation containing only scenario-permitted state views, validates a
typed action object for the complete scenario action surface, creates one
revision/idempotency-stamped action envelope, invokes the corresponding domain
operation, and writes one JSONL audit record per step. Each record retains the
raw callback output, parsed action, envelope, tool result, revisions,
idempotency status, and any failure. Read actions are explicitly marked
`not_applicable` for idempotency, while revision-bearing actions are marked
`applied` or `not_applied`.

Run the deterministic smoke:

```sh
pnpm exec tsx experiments/external-policy/smoke.mts
```

Keep the generated audit file at a chosen location with:

```sh
pnpm exec tsx experiments/external-policy/smoke.mts --out=/tmp/external-policy.jsonl
```

The callback is deliberately a fake deterministic fixture and emits
`bbgm_advance`; the harness itself supports all gameplay, read, and checkpoint
actions represented by the scenario contract. No learned model, Tinker SDK
call, or Tinker result is claimed. The smoke uses `DomainService` directly
rather than a stdio MCP client; this keeps the focused harness independent of
client transport while exercising the same revision, policy, and idempotency
boundaries used by the MCP tools.
