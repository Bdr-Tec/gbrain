# Self-hosted rerankers — vLLM (recommended), llama-server, any Cohere-dialect endpoint

## Start here: which reranker should you run?

gbrain's default reranker is **`cohere:rerank-v3.5`** (hosted, v0.42.69.0+).
Set `COHERE_API_KEY` and you are done — no config needed:

```bash
export COHERE_API_KEY=<your-key>
gbrain models doctor                 # expect: ✔ reranker_config cohere:rerank-v3.5 ok
```

For daemon, launchd, and MCP contexts that don't inherit your shell, put the
key in `~/.gbrain/config.json` instead — it is threaded all the way into the
gateway:

```json
{ "cohere_api_key": "<your-key>" }
```

`gbrain config set cohere_api_key …` writes the DB plane, which `loadConfig()`
deliberately does **not** merge for any `*_api_key` field (same long-standing
gap as `zeroentropy_api_key` / `voyage_api_key`). Use the env var or the
config file.

If you have no key, nothing breaks: search skips the reranker arm entirely and
returns RRF order (#3421). It does **not** issue a doomed request per query.

If you want rerank with **no API spend or no egress**, self-host. The rest of
this page is that path.

| Option | Endpoint | Verdict |
|---|---|---|
| **vLLM** `--task score` | `/rerank`, `/v1/rerank`, `/v2/rerank` | **Recommended.** vLLM's docs label it the "Cohere Rerank API", which is the dialect `gateway.rerank()` already speaks — so it works through the existing `cohere` recipe by repointing `base_url`. No new recipe, no adapter. |
| **llama.cpp** `llama-server --reranking` | `/v1/rerank` | Works, but read the scoring warning below before you trust it. Uses the `llama-server-reranker` recipe. |

### vLLM (recommended) — reuse the cohere recipe

Because vLLM serves the Cohere dialect, you do not need a gbrain code change:

```bash
vllm serve BAAI/bge-reranker-v2-m3 --task score --port 8000

# Point the cohere recipe at your own server. /v1 and /v2 both work on vLLM.
gbrain config set provider_base_urls.cohere http://your-host:8000/v1
gbrain config set search.reranker.model cohere:rerank-v3.5   # already the default
export COHERE_API_KEY=not-used-but-the-recipe-requires-one
```

The model string after the colon must be one of the recipe's allowlisted ids;
vLLM ignores the `model` field when it serves a single model, so leaving the
default is fine. If you need a different id in the request body, use the
`llama-server-reranker` recipe instead — its allowlist is open.

### ⚠️ llama.cpp scoring correctness — verify your build

llama.cpp [issue #16407](https://github.com/ggml-org/llama.cpp/issues/16407)
(opened 2025-10-03, **closed as completed 2025-10-09**) reported
`llama-server --reranking` returning near-zero, uncorrelated scores — on the
order of `1e-28` — for Qwen3-Reranker (0.6B/4B/8B), and wrong or
non-matching scores for BGE, mxbai, and Jina rerankers. It is *fixed
upstream*, but the failure mode is silent: gbrain's fail-open contract cannot
detect "the server answered 200 with garbage numbers", and neither can
`gbrain models doctor`. So:

- **Build from a commit after 2025-10-09.** Anything older can silently
  destroy your ranking quality while looking perfectly healthy.
- **Sanity-check the scores by hand** after any llama.cpp upgrade:

  ```bash
  curl -s http://localhost:8081/v1/rerank -H 'Content-Type: application/json' \
    -d '{"model":"m","query":"how do I reset my password?",
         "documents":["Password reset instructions","Cheese is a dairy product"]}' \
  | jq '.results'
  ```

  The password document must score clearly higher, and scores must not be
  ~`1e-28`. If they are, your build predates the fix (or the GGUF conversion
  lost the pooling/rank metadata).
- Prefer vLLM if you cannot pin and verify a llama.cpp build.

---

## llama-server (local) — Qwen3-Reranker, self-hosted ZE, any Cohere-dialect provider

[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
is the HTTP wrapper that ships with llama.cpp. With `--reranking`, it
exposes a `POST /v1/rerank` endpoint that returns
`{results: [{index, relevance_score}]}` — the Cohere rerank dialect, which is
the single wire shape `gateway.rerank()` drives for every provider it supports
(Cohere, ZeroEntropy, DashScope, OpenRouter). Voyage (`top_k` / `data[]`) is
the sole outlier. The
`llama-server-reranker` recipe (added in v0.40.6.1) routes
`gateway.rerank()` at your local llama.cpp instance instead of ZE.

Two flavors of "local" this recipe covers:

- **Qwen3-Reranker** (0.6B / 4B / 8B) — open-weight cross-encoder; pull
  the GGUF from HuggingFace and serve.
- **Self-hosted ZeroEntropy** (`zerank-2`, `zerank-1-small`) — the
  weights are on HuggingFace too and are **Apache-2.0** upstream (verified
  2026-07-28; they were previously CC-BY-NC-4.0 and third-party model pages
  still say non-commercial — check the upstream repo, not the mirrors). Self-hosting is
  the way to keep using them after ZE's hosted API sunsets 2026-09-04 —
  GGUF-convert them and serve them the same way. **Quality is not guaranteed to match ZE-hosted:** GGUF
  conversion + quantization + pooling/rank metadata + tokenizer special
  tokens all affect scores. If you self-host ZE for production
  retrieval, pin your own brain-relevant eval (
  [docs/eval-bench.md](../eval-bench.md)) as a regression guard.

This recipe is the path override + recipe shape. Any provider serving the
Cohere dialect can use it (or the `cohere` recipe) by just pointing at a
different base URL. Providers whose wire shape differs (Voyage uses `top_k`
not `top_n`, returns `data[]` not `results[]`) need a separate recipe with
adapter hooks — that lands in a follow-up plan.

## Setup

### 1. Build llama.cpp (or download a release)

```bash
# Clone and build (CPU only; add `-DGGML_CUDA=ON` for GPU)
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
cmake -B build
cmake --build build --config Release -j
```

Pin a specific commit when you ship — `llama-server`'s path aliases
(`/rerank`, `/v1/rerank`, `/reranking`, `/v1/reranking`) have shifted
across releases. The recipe sends to `/v1/rerank`.

### 2. Pull a reranker GGUF

For Qwen3-Reranker-4B (quantized Q4_K_M is the sweet spot for CPU):

```bash
# Pick a quant level — Q4_K_M is the usual CPU sweet spot.
huggingface-cli download \
  Qwen/Qwen3-Reranker-4B-GGUF qwen3-reranker-4b-q4_k_m.gguf \
  --local-dir ./models
```

For self-hosted ZeroEntropy weights, find a community GGUF conversion
or convert from the HuggingFace weights yourself (out of scope of this
doc — see llama.cpp's `convert_hf_to_gguf.py`).

### 3. Launch llama-server with --reranking AND --alias

```bash
./build/bin/llama-server \
  --model ./models/qwen3-reranker-4b-q4_k_m.gguf \
  --alias qwen3-reranker-4b \
  --reranking \
  --port 8081
```

The `--alias` matters: without it, llama-server's `/v1/models` (and the
`model` field rerank requests echo) defaults to the full gguf file
path, which makes the gbrain config string ugly and brittle. With
`--alias qwen3-reranker-4b`, your config string is short and stable.

`--reranking` and `--embeddings` are mutually exclusive at server
launch. If you also run a local embedder via the
[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
recipe, run two separate llama-server processes on two different ports
(typically 8080 for embeddings, 8081 for reranking — gbrain's defaults
match that convention).

### 4. Wire gbrain at your server

```bash
# Point gbrain at the llama.cpp host (skip if running locally on default port)
gbrain config set provider_base_urls.llama-server-reranker http://your-host:8081/v1

# Tell search to use this reranker
gbrain config set search.reranker.model llama-server-reranker:qwen3-reranker-4b
gbrain config set search.reranker.enabled true
```

The `qwen3-reranker-4b` after the colon is your `--alias` value from
step 3. Any string works as long as it matches your server's alias.

Env vars work too as an alternative to the config set above:

```bash
export LLAMA_SERVER_RERANKER_BASE_URL=http://your-host:8081/v1
# Optional: if you front llama-server with nginx + bearer auth
export LLAMA_SERVER_RERANKER_API_KEY=your-bearer-token
```

### 5. Verify

```bash
gbrain models doctor
# Expect: ✔ reranker_config llama-server-reranker:qwen3-reranker-4b ok
#         ✔ reranker_config llama-server-reranker:qwen3-reranker-4b ok (reachability)

gbrain search "some query" --json | jq '.[].rerank_score'
# Expect: rerank_score on every row
```

If `gbrain models doctor` reports the reachability probe as `network`
status, two common causes:

1. The server is reachable but in embedding mode, not reranking mode.
   `--reranking` and `--embeddings` are mutually exclusive at launch
   — relaunch the right one.
2. The recipe path doesn't match what your llama.cpp version serves.
   This recipe sends `/v1/rerank`; older llama.cpp installs may only
   serve `/rerank`. Pin to a recent llama.cpp commit.

## Cold-start headroom

CPU-only first-call warmup on a 4B reranker can take 8-15 seconds. The
recipe declares `default_timeout_ms: 30000` so the first call after a
server restart doesn't fail-open silently. That value flows through
search-mode resolution unless you override it:

```bash
# Tighten or loosen per-search timeout (overrides recipe default):
gbrain config set search.reranker.timeout_ms 60000
```

Per-call overrides in `SearchOpts.reranker_timeout_ms` still win for
any single call.

## Budget caps + local rerank

The recipe declares `cost_per_1m_tokens_usd: 0` and registers under
`FREE_LOCAL_RERANK_PROVIDERS` in the budget tracker, so
`--max-cost`-bounded callers (autopilot loops, batch jobs) do NOT
hard-fail when configured for local rerank. Local rerank costs
electricity, not API tokens.

```bash
GBRAIN_MAX_USD=0.01 gbrain search "..." --reranker llama-server-reranker:qwen3-reranker-4b
# Works: rerank fires, recorded at $0, cumulative cap untouched.
```

## Fail-open contract preserved

`applyReranker` in `src/core/search/rerank.ts` still has the
fail-open posture: any error class (network, timeout, malformed
response) logs to `~/.gbrain/audit/rerank-failures-*.jsonl` and
returns the original RRF order unchanged. Search reliability beats
reranker quality. If your llama.cpp host goes down, your searches keep
working — they just stop ranking against the cross-encoder until you
restart the server.
