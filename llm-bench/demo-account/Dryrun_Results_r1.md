# demo-account Dry-run Results — Round 1 (2026-10-28)

**Target**: `QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE` — Qwen/Qwen3.5-35B-A3B (MoE), vLLM 0.26.0, TP=4, max-model-len 32768, `QWEN_MULTI_POOL` (GPU_NV_M = 4× A10G 24GB, PCIe)
**Client**: `vllm bench serve`, run as an SPCS job service on a temporary CPU_X64_S pool against `http://qwen-service:8000` (internal, bypassing the relay). Random tokens with `--ignore-eos`.
**Data**: `QWEN_MULTI_DB.QWEN_MULTI_SCH.BENCH_RESULTS` / `BENCH_COLDSTART` / `BENCH_RUN_LOG` (run_id = `r1`)
**SLA**: TTFT p95 < 2s · E2E p95 < 30s · ≥ 15 tok/s per request · 0 failures

> ⚠️ The model and serving config are not the customer's (MoE, not dense 32B; eager mode is on). These numbers are **not Customer capacity**. They show that the method works and expose some platform issues.

## 1. Summary

1. **Kit and process: ✅ work end to end in the CN region.** Job service, stage volume mounts, template rendering, result JSON fields, loading into the table, and the views all work. 0 failures across 650+ requests.
2. **No step met the SLA. Every step failed the per-request ≥ 15 tok/s target**, single request included (only ~12 tok/s).
   Cause, from the server logs: `enforce_eager=True` turns off CUDA Graphs; the 4 A10G cards are connected over PCIe only, so custom all-reduce is off and every layer's TP all-reduce goes over NCCL; there is no tuned MoE kernel config for A10G.
   **This is a service config issue, not a GPU compute limit**: total throughput grows almost linearly with concurrency (12 → 342 tok/s).
3. **Replica scaling (T4b/T5): ❌ blocked by a platform limit.** `ALTER SERVICE ... SET MIN_INSTANCES=2` returned
   `Unsupported feature 'Services that contain volumes with 'block' source cannot be scaled up or down'`.
   → **If Customer puts weights on a block volume, they cannot add replicas by changing MIN_INSTANCES.** Each extra "replica" has to be a separate service, with a load balancer in front.
4. **Cold start: 13–17 minutes.** Most of it is vLLM loading weights from the block volume (546 s). That fits the ~70GB of weights at the volume's configured 125 MiB/s throughput.

## 2. Test 1 — Baseline (concurrency 1)

| Prompt | In / Out | TTFT p50 | TTFT p95 | TPOT p95 | tok/s per request | E2E p95 | SLA |
|---|---|---|---|---|---|---|---|
| short | 256 / 256 | 0.11 s | 0.12 s | 83.0 ms | 12.0 | 22.8 s | ❌ tok/s |
| medium | 2048 / 512 | 0.58 s | 0.59 s | 82.9 ms | 12.1 | 45.8 s | ❌ tok/s, E2E |
| long | 8192 / 512 | 1.97 s | 2.22 s | 82.6 ms | 12.1 | 48.1 s | ❌ tok/s, TTFT, E2E |

Decode speed is fixed at ~12 tok/s regardless of prompt length. Prefill runs at ~4,000 tokens/s (8K prompt ≈ 2 s).

## 3. Test 2 — Concurrency ramp (1024 in / 512 out)

| Concurrency | TTFT p95 | TPOT p95 | tok/s per request | E2E p95 | Req/s | Total output tok/s |
|---|---|---|---|---|---|---|
| 1 | 0.30 s | 82.8 ms | 12.1 | 46.4 s | 0.023 | 12 |
| 2 | 0.57 s | 89.0 ms | 11.2 | 48.6 s | 0.043 | 23 |
| 4 | 1.12 s | 86.3 ms | 11.6 | 48.0 s | 0.088 | 45 |
| 8 | 1.82 s | 88.3 ms | 11.3 | 49.6 s | 0.169 | 87 |
| 16 | **3.33 s** | 96.2 ms | 10.4 | 54.4 s | 0.319 | 164 |
| 32 | **6.86 s** | 103.0 ms | 9.7 | 60.0 s | 0.588 | 303 |

- Up to concurrency 8, TTFT stays under 2s and the per-request speed barely drops. Concurrency 16 is where TTFT goes over the target.
- With the tok/s target relaxed to ≥ 10 tok/s, this service could handle about **8 concurrent requests**. At 15 tok/s, it handles 0.

## 4. Test 3 — Token shape

| Concurrency | RAG 6144/256: TTFT p95 | RAG: tok/s per request | RAG: E2E p95 | Chat 256/1536: TTFT p95 | Chat: tok/s per request | Chat: E2E p95 |
|---|---|---|---|---|---|---|
| 1 | 1.64 s | 12.0 | 24.5 s | 0.12 s | 12.0 | 138.5 s |
| 2 | 2.80 s | 11.2 | 27.1 s | 0.30 s | 11.7 | 142.8 s |
| 4 | 5.35 s | 9.6 | 31.2 s | 0.42 s | 11.7 | 140.9 s |
| 8 | 9.79 s | 7.9 | 39.5 s | 0.64 s | 11.6 | 143.8 s |
| 16 | 19.94 s | 5.7 | 59.1 s | 1.15 s | 11.4 | 145.4 s |
| 32 | 39.67 s | 4.5 | 104.1 s | 2.20 s | 11.3 | 148.8 s |
| **Peak total output tok/s** | | | **109** | | | **342** |

- **RAG (prefill-heavy) is under the most pressure**: at concurrency 2, TTFT is already over 2s, and long prefills slow down the decode of the other requests.
- **Chat (decode-heavy)**: TTFT stays low up to concurrency 16, but 1,536 tokens at 12 tok/s means E2E is always over 130s. An R1-type reasoning model writes long thinking chains, so Customer will hit the same E2E problem.
- → For the customer's RAG / chat traffic, TTFT will be the first limit hit. Prefix caching is worth turning on (system prompts and documents get reused).

## 5. Test 4 — Cold start

| Scenario | Timeline | Total |
|---|---|---|
| Initial resume (pool suspended → new node) | RESUME 09:46:51 → node / relay READY ~09:51 (~4.5 min) → weights loaded 10:01:24 (546 s) → engine init 95 s → vLLM READY 10:03:40 | **16.8 min** |
| Restart (service SUSPEND/RESUME, pool kept running) | RESUME → probe start 27 s → `/v1/models` ready 754 s → first response 759 s | **13.1 min** |
| Scale-up 1→2 | ❌ Not supported on block volumes (see §1.3) | – |

Main contributor: loading weights from the block volume (125 MiB/s). Possible improvements: raise `blockConfig.throughput`/`iops`; put the weights on a stage volume or local disk; or keep a warm standby service instead of relying on autoscaling.

## 6. Implications for Customer

1. **Check the Customer production spec first**:
   - Is `--enforce-eager` set? Does it use a block volume? What are custom all-reduce / NCCL settings?
   - If eager mode is on, add a round-2 A/B test with it off: CUDA Graphs usually speed up decode noticeably. Expect the gain to be large, but measure it.
2. **Replica scaling plan**:
   - If Customer uses a block volume, test 5 should be "2 separate services + load balancing on the client/gateway side", not MIN_INSTANCES.
   - Otherwise (stage volume or weights inside the image), test the MIN_INSTANCES approach as planned.
3. **The SLA may be hard to meet on GPU_NV_M**: a dense 32B at TP=4 over PCIe, with A10G bandwidth, decodes noticeably slower than a 3B-active MoE.
   - Recommendation: before the formal test, agree with Customer that the 15 tok/s target is negotiable, or that a larger GPU instance (GPU_NV_L / H-series, if available in CN) will be evaluated.
4. **Test window**: on this service, T1–T3 at concurrency 1–32 took about **2h25m** (baseline 35 min, ramp 24 min, shape 84 min). For Customer at 1–64 concurrency, budget **4–5 hours** plus 15–20 minutes of cold start.

## 7. Kit fixes made during the dry run

- `RUN_BENCH`: the template `USING` values were double-quoted, causing a YAML parse error → fixed.
- `WAIT_READY`: it counted every READY container, so a service with a sidecar was counted twice → now filters on the `vllm` container (overload signature changed).
- `run_bench.sh`: added `MIN_PROMPTS` to set the minimum number of requests per step, so runs finish in reasonable time on slow services.
- `BENCH_COLDSTART` view: the join returned duplicate rows → now matches `test='coldstart_restart'`.
- The bench client can reuse the server's vLLM image and mount its scripts from a stage, so no new image is needed (`demo-account/bench_job.yaml`).

## 8. Cleanup

- `QWEN_SERVICE` is SUSPENDED, `QWEN_MULTI_POOL` is SUSPENDED with MAX_NODES back to 1, and MIN/MAX_INSTANCES are unchanged at 1/1.
- The temporary `BENCH_CPU_POOL` and all `BENCH_*` job services have been dropped.
- Kept for later queries:
  - Tables and views: `BENCH_RAW` / `BENCH_RUN_LOG` / `BENCH_RESULTS` etc.
  - Stages: `BENCH_*_STAGE`
  - Procedures: `RUN_BENCH` etc.
  - The suspended task `BENCH_ROUND_TASK`
- Delete them on request.
- `GRANT EXECUTE TASK ON ACCOUNT TO ROLE QWEN_MULTI_ROLE` is still in place. It was added for this test; revoke if not needed.
