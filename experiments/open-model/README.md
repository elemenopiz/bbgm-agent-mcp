# Open-model evaluation adapter

`tinker-compatible-adapter.mts` is a real typed policy adapter. It sends one
bounded JSON observation at a time to an OpenAI-compatible chat-completions
endpoint, parses exactly one action against the repository's Zod action schema,
and applies that action through the same `AgentEnvironment` capability used by
the deterministic policies. It supports both:

- a Tinker sampler (`TINKER_BASE_URL`, `TINKER_MODEL`, `TINKER_API_KEY`); and
- a local open-weight model server (`BBGM_MODEL_BASE_URL`, `BBGM_MODEL_ID`).

Tinker mode follows the documented OpenAI-compatible endpoint and sampler
weight path. The repository never stores credentials or a checkpoint.

## Local reproducible run

Install Python `torch`, `transformers`, and `huggingface_hub` in the execution
environment. Download the exact model revision recorded in
`model-manifest.json`:

```sh
python3 - <<'PY'
from huggingface_hub import snapshot_download
path = snapshot_download(
    "HuggingFaceTB/SmolLM2-135M-Instruct",
    revision="12fd25f77366fa6b3b4b768ec3050bf629380bac",
)
print(path)
PY
```

Start the local compatible server in one terminal:

```sh
python3 scripts/serve-local-open-model.py \
  --model /path/to/the/resolved/model/snapshot
```

Run the adapter through the bounded smoke manifest in another terminal. The
command includes unchanged no-op and heuristic controls. The adapter emits
per-step model traces under `BBGM_MODEL_TRACE_DIR` and the evaluator emits the
normal report and trajectory evidence:

```sh
BBGM_SOURCE_DIR=.cache/zengm \
BBGM_MODEL_BASE_URL=http://127.0.0.1:8000/v1 \
BBGM_MODEL_ID=HuggingFaceTB/SmolLM2-135M-Instruct \
BBGM_MODEL_TRACE_DIR=.data/open-model-traces \
BBGM_MODEL_SEED=0 \
pnpm research:open-model \
  --scenario scenarios/open-model-smoke-v1.json \
  --adapter experiments/open-model/tinker-compatible-adapter.mts \
  --policy untrained_open_model \
  --seed grant-seed-001 \
  --data-root .data/open-model-smoke \
  --out .data/open-model-smoke/report.json
```

This is an untrained open-model measurement, not a Tinker-trained result. A
Tinker run must record the sampler weight path, base model, Tinker client/API
version, decoding parameters, prompt hash, and the exact evaluated seed set.
