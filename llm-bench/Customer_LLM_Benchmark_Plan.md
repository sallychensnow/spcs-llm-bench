# vLLM on SPCS: Capacity Benchmark & Performance Test Plan (template)

**Round 1 · Owner: Snowflake SE**
Background: a customer serves an LLM through an OpenAI-compatible vLLM endpoint on SPCS (for example chat assistants, RAG and BI copilots) and wants to know how much load it can take within an agreed SLA. Replace the targets and names below with your own.

---

## 1. Goals & SLA

| Metric | Target | Notes |
|---|---|---|
| TTFT p95  | **< 2 s** | Time to first token |
| End-to-end latency p95  | **< 30 s** | Full response |
| Per-request output speed  | **≥ 15 tok/s** | ⇔ TPOT p95 ≤ 66.7 ms |
| Error rate  | 0% | All requests in a step must complete |

**Capacity definition**: the highest concurrency step that meets **all four** criteria = *max SLA concurrency* for that workload shape.

> Note: if the model is a reasoning model, its `<think>` output is counted as output tokens, so real chat answers are often longer than users expect. Test 3 uses 1,536 output tokens for chat to reflect this.

## 2. Environment

- **PoC service isolation**: `LLM_BENCH.BENCH.LLM_POC`, on its own pool `LLM_POC_GPU_POOL` (GPU_NV_M, MAX_NODES = 2). **The production endpoint is not touched.**
- vLLM image, version, weights and server flags are **identical to production** (`max-model-len`, `tensor-parallel-size`, `gpu-memory-utilization`, `max-num-seqs`).
- **Benchmark client**: the official `vllm bench serve` (the same vLLM image), run as an **SPCS job service** on a separate CPU pool. It calls the PoC through internal service DNS, so no public network or ingress is involved.
- **Orchestration**: Snowflake Task `BENCH_ROUND_TASK` → stored procedures → `EXECUTE JOB SERVICE`. Results are written as JSON to `@RESULTS_STAGE`, loaded into `BENCH_RAW`, and exposed through SQL views.
- Workload: synthetic random tokens (`--dataset-name random`, `--ignore-eos`) so output lengths are fixed and repeatable. Optional round 2: replay sampled real chat / RAG prompts.

## 3. Test Matrix

| # | Test | Input / Output tokens | Concurrency | Requests per step | Key output |
|---|---|---|---|---|---|
| 1 | Baseline | short 256/256 · medium 2048/512 · long 8192/512 | 1 | 20 / 20 / 10 | TTFT, TPOT, tok/s, E2E per prompt length |
| 2 | Concurrency ramp | 1024/512 (typical) | 1, 2, 4, 8, 16, 32, 64 | max(20, 4×c) | Latency curve; **max SLA concurrency**; peak throughput |
| 3 | Token shape | RAG 6144/256 vs Chat 256/1536 | 1 … 64 | max(20, 4×c) | Prefill-bound vs decode-bound capacity |
| 4a | Cold start – restart | 1 token probe | – | 1 | RESUME → `/v1/models` ready → first response |
| 4b | Cold start – scale-up | – | – | – | MIN_INSTANCES 1→2 → 2nd replica READY (incl. GPU node provisioning) |
| 5 | Replica scaling | 1024/512 | 1 … 128 | max(20, 4×c) | Throughput 1 vs 2 replicas (ideal 2.0×), max SLA concurrency, per-replica request split |

Each test begins with a 5-request warm-up that is excluded from results. Percentiles are p50 / p90 / p95 / p99.

## 4. Execution

1. `sql/00_setup.sql`: role, DB, stages, image repo, GPU PoC pool and CPU client pool. **Check the GPU quota for 2 nodes in your region first.**
2. Push the vLLM image (same tag as prod) and the bench client image (`image/Dockerfile`). Upload `spec/bench_job.yaml` to `@SPEC_STAGE`. Make the weights and tokenizer available in `@MODEL_STAGE`.
3. `sql/01_poc_service.sql`: copy the production spec flags, then create and verify the PoC service.
4. Create the procedures, task and views (`sql/02_bench_job.sql`, `sql/03_results.sql`).
5. Smoke test: `CALL RUN_BENCH('baseline','smoke',1);` → `CALL LOAD_RESULTS();` → `SELECT * FROM BENCH_RESULTS;`
6. Full round, off-peak: `EXECUTE TASK BENCH_ROUND_TASK;` (several hours). Single tests can be run separately with `RUN_BENCH` / `RUN_COLDSTART`.
7. For per-replica distribution, set `ALTER SERVICE LLM_POC SET LOG_LEVEL='INFO'` before test 5 and confirm an account event table is active.

## 5. Deliverables

- Results tables and views: `BENCH_RESULTS`, `BENCH_CAPACITY`, `BENCH_REPLICA_GAIN`, `BENCH_COLDSTART`
- Report covering: latency vs concurrency curves per shape; capacity table (max SLA concurrency and req/s per GPU_NV_M replica); cold-start timings; replica scaling factor
- Sizing recommendation: replicas needed = peak concurrent users ÷ max SLA concurrency per replica, plus headroom. If tuning looks promising, list candidates for a round-2 A/B test (`max-num-seqs`, prefix caching for RAG, `max-model-len`, quantization).

## 6. Risks & Assumptions

| Item | Impact | Mitigation |
|---|---|---|
| GPU quota < 2 nodes | Test 5 / 4b blocked | Request quota early; tests 1–4a can still run |
| Hugging Face Hub / Docker Hub unreachable (e.g. Snowflake China regions) | Tokenizer/image pull fails | Tokenizer comes from the stage mount; images go through the account's image repository |
| PoC config drifts from prod | Results don't transfer to prod | Diff the `DESCRIBE SERVICE` spec before running |
| Synthetic prompts ≠ real traffic | Capacity estimate is off (e.g. prefix-cache benefit is lost) | Round 2 with sampled real prompts |
| SPCS internal load balancing is not strictly round-robin | Replica gain < 2× | Measured per instance via event-table logs |
| GPU cost | PoC pool bills while active | AUTO_SUSPEND, run in one window, then `ALTER COMPUTE POOL ... SUSPEND` |
