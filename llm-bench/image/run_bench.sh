#!/usr/bin/env bash
# the customer LLM benchmark driver. Runs inside an SPCS job service.
# Usage (set via job spec args / env):
#   TEST=baseline|ramp|shape|coldstart|replica  RUN_ID=<id>
# Env:
#   BASE_URL   e.g. http://llm-poc:8000   (PoC service internal DNS — NOT prod)
#   MODEL      served model name (as in /v1/models)
#   TOKENIZER  local path to tokenizer files (stage mount; HF hub not reachable in CN)
#   OUT_DIR    results mount (stage volume), default /results
#   CONCURRENCY_LEVELS  default "1 2 4 8 16 32 64"
#   PROMPTS_PER_LEVEL   default 4x concurrency, min 20
set -euo pipefail

TEST="${TEST:?TEST required}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BASE_URL="${BASE_URL:?BASE_URL required}"
MODEL="${MODEL:?MODEL required}"
TOKENIZER="${TOKENIZER:-/models/tokenizer}"
OUT_DIR="${OUT_DIR:-/results}/${RUN_ID}/${TEST}"
LEVELS="${CONCURRENCY_LEVELS:-1 2 4 8 16 32 64}"
mkdir -p "$OUT_DIR"

# vLLM >= 0.10 ships `vllm bench serve`; older images only have benchmarks/benchmark_serving.py
if vllm bench serve --help >/dev/null 2>&1; then
  BENCH=(vllm bench serve)
else
  BENCH=(python3 /workspace/benchmarks/benchmark_serving.py)
fi

# bench <label> <input_len> <output_len> <concurrency> <num_prompts>
bench() {
  local label=$1 in_len=$2 out_len=$3 conc=$4 n=$5
  echo "[$(date -u +%T)] $label in=$in_len out=$out_len conc=$conc n=$n"
  "${BENCH[@]}" \
    --backend openai --base-url "$BASE_URL" --endpoint /v1/completions \
    --model "$MODEL" --tokenizer "$TOKENIZER" \
    --dataset-name random --random-input-len "$in_len" --random-output-len "$out_len" \
    --random-range-ratio 0.1 --ignore-eos \
    --num-prompts "$n" --max-concurrency "$conc" --request-rate inf \
    --percentile-metrics ttft,tpot,itl,e2el --metric-percentiles 50,90,95,99 \
    --save-result --result-dir "$OUT_DIR" \
    --result-filename "${label}_in${in_len}_out${out_len}_c${conc}.json" \
    --metadata run_id="$RUN_ID" test="$TEST" label="$label"
}

warmup() { bench warmup 128 32 1 5 >/dev/null || true; rm -f "$OUT_DIR"/warmup_*.json; }

n_for() { local m=${MIN_PROMPTS:-20} n=$(( $1 * 4 )); (( n < m )) && n=$m; echo "${PROMPTS_PER_LEVEL:-$n}"; }

case "$TEST" in
  baseline)   # 1. single-request latency: short / medium / long prompts
    warmup
    bench short   256  256 1 20
    bench medium 2048  512 1 20
    bench long   8192  512 1 10
    ;;
  ramp)       # 2. concurrency ramp on a mixed "typical" shape
    warmup
    for c in $LEVELS; do bench ramp 1024 512 "$c" "$(n_for "$c")"; done
    ;;
  shape)      # 3. RAG (long in / short out) vs chat (short in / long out) across concurrency
    warmup
    for c in $LEVELS; do
      bench rag  6144  256 "$c" "$(n_for "$c")"
      bench chat  256 1536 "$c" "$(n_for "$c")"
    done
    ;;
  coldstart)  # 4. poll until the service answers a real completion
    python3 "${COLD_START_PY:-/opt/bench/cold_start.py}" --base-url "$BASE_URL" --model "$MODEL" \
      --out "$OUT_DIR/coldstart.json" --run-id "$RUN_ID"
    ;;
  replica)    # 5. same ramp, to be run once per MIN_INSTANCES setting
    warmup
    for c in $LEVELS; do bench "replica_${REPLICAS:-unknown}" 1024 512 "$c" "$(n_for "$c")"; done
    ;;
  *) echo "unknown TEST=$TEST"; exit 2 ;;
esac
echo "done -> $OUT_DIR"
