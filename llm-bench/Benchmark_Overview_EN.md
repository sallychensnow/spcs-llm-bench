# Customer LLM Inference Capacity Benchmark — End-to-End Overview

> Purpose: a single, detailed explanation of everything done for this benchmark — what was tested, why, how, which Snowflake operations ran, and how to read the results.
> Scope: Customer test plan → demo-account dry run → LLM Bench Console (one-click test app).
> Dates: 2026-10-28 to 2026-11-03 (r2 tuning run added 11-03)

---

## Contents

1. [Background and goals](#1-background-and-goals)
2. [Design principles](#2-design-principles)
3. [Metrics explained](#3-metrics-explained)
4. [The five tests](#4-the-five-tests)
5. [Architecture and Snowflake objects](#5-architecture-and-snowflake-objects)
6. [What happens inside Snowflake during a run](#6-what-happens-inside-snowflake-during-a-run)
7. [Timeline of actual operations](#7-timeline-of-actual-operations)
8. [Dry-run results and interpretation](#8-dry-run-results-and-interpretation)
9. [Issues found and fixes](#9-issues-found-and-fixes)
10. [The one-click console app](#10-the-one-click-console-app)
11. [Notes for the Customer rollout](#11-notes-for-the-customer-rollout)
12. [File index](#12-file-index)
13. [Glossary](#13-glossary)

---

## 1. Background and goals

**Customer setup**: the customer serves a dense ~32B reasoning model with vLLM on SPCS (Snowpark Container Services) in Snowflake China. It is exposed as an OpenAI-compatible endpoint to internal applications. Current compute: one GPU_NV_M compute pool.

**Request**: capacity benchmarking and performance testing.

**Customer SLA (pass criteria)**:

| Metric | Target |
|---|---|
| TTFT p95 (time to first token) | < 2 s |
| End-to-end latency p95 | < 30 s |
| Per-request output speed | ≥ 15 tokens/s |
| Failure rate | 0 |

**Questions to answer**: on one GPU_NV_M,
- how many concurrent users can be served within the SLA?
- how do RAG-style and chat-style traffic differ?
- how long does a restart take before the service answers again?
- does adding a replica double capacity?

---

## 2. Design principles

### 2.1 Core principles

1. **Never test production.**
   - Create a **PoC copy** of the production service: same image, weights and vLLM flags.
   - Run every test against the copy, because load, cold-start and scaling tests would all disrupt production traffic.
2. **Run the load generator inside Snowflake.**
   - The client runs as an SPCS job and calls the model over Snowflake **internal DNS** (e.g. `http://qwen-service:8000`).
   - No public network, ingress or egress latency gets in the way, so we measure the model service itself.
   - No external load-test machine is needed: everything stays in the customer account and no data leaves it.
3. **Use the standard tool.**
   - We use vLLM's official `vllm bench serve` rather than a hand-written script.
   - Its methodology is widely accepted, it reports full percentile metrics, and the customer can reproduce the results.
4. **Same image for client and server.** The client reuses the server's vLLM image, so no separate image has to be built and tokenizer behaviour matches exactly.
5. **Reproducible results.**
   - Inputs are random tokens of fixed length.
   - `--ignore-eos` forces every request to generate the full output length.
   - Each step starts with 5 warm-up requests that are excluded from the stats.
6. **Results live in Snowflake.**
   - Each step writes a JSON file to a stage.
   - The files are loaded into a table and analysed with SQL views.
   - Results are auditable and comparable across runs.

### 2.2 Why "Task → SPCS job" rather than "just a Task"

The original suggestion was to run the vLLM benchmark tool from a Snowflake Task. A Task can only execute SQL or stored procedures; it cannot run a Python CLI. The design is therefore:

```
Task  →  stored procedure  →  EXECUTE JOB SERVICE (one-off container)  →  vllm bench serve  →  JSON on a stage
```

- The Task orchestrates.
- The job service does the work.
- The stage stores the output.

### 2.3 Two rounds: dry run first, then the customer

- **Round 1 (done)**:
  - Dry run in our own China account `demo-account` (cn-northwest-1, AWS Ningxia), against its existing Qwen service.
  - Goals: prove the kit works in the China region, flush out problems, and estimate runtime and cost.
- **Round 2 (next)**: install in the Customer account and test their PoC service.

---

## 3. Metrics explained

All numbers come from the JSON written by `vllm bench serve`. The `BENCH_RESULTS` view flattens it into rows.

### 3.1 Latency metrics (per request)

| Metric | Full name | Meaning | Mainly driven by | vLLM output field |
|---|---|---|---|---|
| **TTFT** | Time To First Token | Request sent → first token received; how long the user stares at a blank screen | **Prefill** (longer input = slower), plus queueing under load | `p95_ttft_ms` |
| **TPOT** | Time Per Output Token | Average time per output token after the first | **Decode** speed | `p95_tpot_ms` |
| **ITL** | Inter-Token Latency | Gap between consecutive tokens (finer-grained than TPOT) | Decode | `p95_itl_ms` |
| **E2E** | End-to-End Latency | Request sent → last token received | ≈ TTFT + TPOT × output tokens | `p95_e2el_ms` |

**Per-request tok/s** is not reported directly. It is derived as `1000 / TPOT p95 (ms)`. Using p95 means **the slowest 5% of requests** must still reach 15 tok/s, which is stricter than an average.

### 3.2 Throughput metrics (whole service)

| Metric | Meaning |
|---|---|
| `request_throughput` (req/s) | Requests completed per second |
| `output_throughput` (tok/s) | **Total** output tokens per second across all concurrent requests; reflects overall GPU capacity |
| `total_token_throughput` | Input + output tokens per second |

### 3.3 Why p95

Averages hide the slow tail. p95 means "95% of requests are at least this fast", which matches user experience better. All SLA checks use p95; p50 and p99 are recorded too.

### 3.4 Definition of "meets SLA"

A concurrency level passes only if **all four** conditions hold:

```
TTFT p95 < 2s  AND  E2E p95 < 30s  AND  1000/TPOT p95 ≥ 15  AND  failed requests = 0
```

**Max SLA concurrency** is the highest concurrency level that passes. This is the capacity answer.

### 3.5 Key concept: prefill vs decode

LLM inference has two phases:

- **Prefill**:
  - Processes all input tokens at once.
  - Compute-heavy and highly parallel.
  - The longer the input, the longer the prefill, and the higher the TTFT.
- **Decode**:
  - Generates output one token at a time.
  - Every step reads all model weights, so it is **bound by memory bandwidth and fixed per-step overhead**.
  - Its speed sets TPOT.

RAG traffic (long retrieved context, short answer) stresses prefill. Chat traffic (short question, long answer, especially a reasoning model's chain of thought) stresses decode. That is why Test 3 measures them separately.

---

## 4. The five tests

| # | Test | Parameters | Question it answers |
|---|---|---|---|
| 1 | **Baseline** | Concurrency 1: short 256 in / 256 out, medium 2048/512, long 8192/512 | Without any queueing, what is the best achievable latency, and how does input length affect TTFT? |
| 2 | **Concurrency ramp** | 1024 in / 512 out at concurrency 1, 2, 4, 8, 16, 32 (64) | As concurrency rises, where does the SLA break? What is peak throughput? |
| 3 | **Token shape** | RAG 6144/256 vs chat 256/1536, each across all concurrency levels | Which traffic pattern hits the wall first, and why? |
| 4 | **Cold start** | (a) suspend → resume the service; (b) scale from 1 to 2 replicas | How long from restart or scale-up to the first response? |
| 5 | **Replica scaling** | The same ramp at 1 replica and at 2 replicas | Does a second replica double capacity? How evenly is load spread? |

**Requests per level**: `max(min_prompts, 4 × concurrency)`. The default minimum is 20; the dry run used 8 to save time. At least four "rounds" per level keeps percentiles stable.

**Why chat output is 1,536 tokens**: The customer's model is a reasoning model. Its `<think>` content counts as output tokens, so real answers are long.

---

## 5. Architecture and Snowflake objects

### 5.1 Architecture

```
┌──────────────────── Snowflake account (everything stays in the customer account) ────────────────────┐
│                                                                                                       │
│  [LLM Bench Console]  Snowflake App Runtime (Next.js)                                                 │
│        │  ① INSERT INTO BENCH_RUNS (QUEUED)                                                           │
│        │  ② EXECUTE TASK BENCH_RUNNER                                                                 │
│        ▼                                                                                              │
│  [Task BENCH_RUNNER] ─CALL→ PROCESS_QUEUE ─→ EXECUTE_RUN(run_id)                                      │
│                                    │                                                                  │
│        ┌───────────────────────────┼──────────────────────────────┐                                   │
│        ▼                           ▼                              ▼                                   │
│  BENCH_ENSURE_READY          RUN_BENCH_JOB (per test)       BENCH_COLDSTART_RESTART                   │
│  (resume + wait for READY)          │                       BENCH_REPLICA                             │
│                                    ▼                                                                  │
│                    EXECUTE JOB SERVICE  (on CPU pool BENCH_CPU_POOL)                                  │
│                    ┌────────────────────────────────┐                                                 │
│                    │ bench container                 │   HTTP (internal DNS)                           │
│                    │  run_bench.sh                   │──────────────────────▶ [vLLM service]           │
│                    │   └ vllm bench serve            │   qwen-service:8000    (GPU_NV_M pool)          │
│                    └──────────┬─────────────────────┘                                                 │
│                               │ writes JSON                                                           │
│                               ▼                                                                       │
│                    @BENCH_RESULTS_STAGE ─COPY INTO→ BENCH_RAW ─views→ BENCH_RESULTS / BENCH_COLDSTART  │
│                                                                                                       │
│  App reads BENCH_RUNS / BENCH_RUN_LOG / BENCH_RESULTS ──→ charts, SLA verdicts, report                │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Snowflake objects (demo-account names)

All bench objects are in `QWEN_MULTI_DB.QWEN_MULTI_SCH`, owned by `QWEN_MULTI_ROLE`.

| Object | Type | Purpose |
|---|---|---|
| `QWEN_SERVICE` | SPCS service (pre-existing) | System under test: vLLM + Qwen3.5-35B-A3B |
| `QWEN_MULTI_POOL` | Compute pool (pre-existing) | GPU_NV_M (4× A10G 24 GB) hosting the model service |
| `BENCH_CPU_POOL` | Compute pool (**created by us**) | CPU_X64_S running the bench client, so it never steals a GPU node |
| `BENCH_TARGETS` | Table | **Whitelist** of testable services. Columns: service FQN, internal URL, model name, tokenizer location, client image, client pool, whether disruptive tests are allowed |
| `BENCH_RUNS` | Table | Run queue and status (QUEUED / RUNNING / DONE …) |
| `BENCH_RUN_LOG` | Table | Per-step event log (step_start / step_done / resume_issued …), including cold-start timestamps |
| `BENCH_RAW` | Table | Raw result JSON (VARIANT) |
| `BENCH_RESULTS` | View | Flattens JSON into one row per (test, shape, concurrency) |
| `BENCH_COLDSTART` | View | Cold-start timings |
| `BENCH_SCRIPTS_STAGE` | Stage | Client scripts `run_bench.sh` and `cold_start.py`, mounted into the job |
| `BENCH_SPEC_STAGE` | Stage | Job spec template `bench_job_generic.yaml` |
| `BENCH_RESULTS_STAGE` | Stage | Mounted into the job; result JSON is written here |
| `MODEL_ARCHIVE_STAGE` | Stage (pre-existing) | Holds the tokenizer files. Mounted into the client at `/models` because Hugging Face is unreachable from China |
| `RUN_BENCH_JOB` etc. | Stored procedures | Orchestration (see §6) |
| `BENCH_RUNNER` | Task | **No schedule**; the app triggers it with `EXECUTE TASK` |
| `LLM_BENCH_CONSOLE` | Application Service | The web console |

---

## 6. What happens inside Snowflake during a run

Walkthrough of a full run (baseline + ramp + shape + cold start + replica).

### Step 0 — the user clicks "Start run"

The app validates the request:
- the target is whitelisted;
- the concurrency levels are valid;
- disruptive tests were confirmed by typing the target name.

Then it runs:

```sql
INSERT INTO BENCH_RUNS (RUN_ID, TARGET_NAME, TESTS, LEVELS, MIN_PROMPTS, SLA, CONFIRM_DISRUPTIVE, STATUS, ...)
SELECT ?, ?, PARSE_JSON(?), ?, ?, PARSE_JSON(?), ?, 'QUEUED', ...;   -- every value is a bind variable
EXECUTE TASK BENCH_RUNNER;
```

### Step 1 — the task drains the queue

`PROCESS_QUEUE()` takes the oldest QUEUED run and calls `EXECUTE_RUN(run_id)`, and repeats until the queue is empty. A task only ever has one running instance, so **runs never overlap**. This matters: two concurrent runs would contaminate each other's numbers.

### Step 2 — bring the target up (warmup)

`BENCH_ENSURE_READY(svc, 'vllm', 1, 2700, TRUE)` runs:

```sql
ALTER SERVICE QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE RESUME;   -- error ignored if already running
-- then every 10 s:
SELECT COUNT(*) FROM TABLE(FLATTEN(PARSE_JSON(SYSTEM$GET_SERVICE_STATUS(svc))))
 WHERE value:status = 'READY' AND value:containerName = 'vllm';    -- count only the vllm container
```

- It times out after 45 minutes.
- It counts only `vllm` because this service also has a `relay` sidecar. Counting every READY container would see one instance as two.

### Step 3 — each load test (baseline / ramp / shape)

`RUN_BENCH_JOB(run_id, 'ramp', 1)` does the following.

1. **Read the run settings.**
   - From `BENCH_TARGETS`: image, URL, model, tokenizer stage and client pool.
   - From `BENCH_RUNS`: concurrency levels and minimum prompts.
2. **Validate inputs.** run_id, levels and pool name are regex-checked, which prevents injection into the dynamic SQL.
3. **Run a synchronous job:**

   ```sql
   EXECUTE JOB SERVICE IN COMPUTE POOL BENCH_CPU_POOL
     NAME = BENCH_<RUN_ID>_RAMP
     FROM @BENCH_SPEC_STAGE SPECIFICATION_TEMPLATE_FILE = 'bench_job_generic.yaml'
     USING (test => '"ramp"', run_id => '"r2026..."', levels => '"1 2 4 8 16 32"',
            image => '"/qwen_multi_db/.../qwen_multimodel:v3"', base_url => '"http://qwen-service:8000"', ...);
   ```

   Template arguments are passed as **JSON strings**. Snowflake only accepts alphanumeric or valid-JSON values here (see §9).
4. **Container start.** The job starts a container with three stages mounted (scripts, tokenizer, results) and runs `run_bench.sh`.
5. **Load generation.** `run_bench.sh` sends 5 warm-up requests, then runs one benchmark per concurrency level:

   ```bash
   vllm bench serve --backend openai --base-url http://qwen-service:8000 --endpoint /v1/completions \
     --model Qwen/Qwen3.5-35B-A3B --tokenizer /models \
     --dataset-name random --random-input-len 1024 --random-output-len 512 --random-range-ratio 0.1 --ignore-eos \
     --num-prompts 32 --max-concurrency 8 --request-rate inf \
     --percentile-metrics ttft,tpot,itl,e2el --metric-percentiles 50,90,95,99 \
     --save-result --result-dir /results/<run_id>/ramp --result-filename ramp_in1024_out512_c8.json
   ```

   - `--max-concurrency 8` keeps at most 8 requests in flight. That is the concurrency level.
   - `--request-rate inf` sends as fast as allowed, so concurrency is the only throttle.
   - `--random-range-ratio 0.1` lets lengths vary by ±10%, so batches are not artificially aligned.
6. **Load results.** When the job exits, `EXECUTE_RUN` calls `LOAD_RESULTS()`:

   ```sql
   COPY INTO BENCH_RAW (file_name, loaded_at, doc)
     FROM (SELECT METADATA$FILENAME, CURRENT_TIMESTAMP(), $1 FROM @BENCH_RESULTS_STAGE)
     FILE_FORMAT = (TYPE = JSON) PATTERN = '.*\\.json';    -- COPY skips files already loaded
   ```

7. **Log the step.** `BENCH_RUN_LOG` records `step_start` / `step_done`, or `step_failed` with the error.

### Step 4 — cold-start test

`BENCH_COLDSTART_RESTART` runs:

```sql
ALTER SERVICE QWEN_SERVICE SUSPEND;
SELECT SYSTEM$WAIT(60);
INSERT INTO BENCH_RUN_LOG ... event = 'resume_issued';     -- t0
ALTER SERVICE QWEN_SERVICE RESUME;
CALL RUN_BENCH_JOB(run_id, 'coldstart', 1);                -- starts the probe
```

The probe `cold_start.py` polls `/v1/models` every 2 s. Once that answers, it sends one 1-token completion and records:
- `models_ready_s`: time until the API was reachable;
- `first_completion_s`: time until the first real answer.

**Total cold start** = (t0 → probe start) + `first_completion_s`. The `BENCH_COLDSTART` view joins the two.

### Step 5 — replica scaling test

`BENCH_REPLICA` does the following.

1. `DESCRIBE SERVICE` records the original MIN/MAX_INSTANCES.
2. Runs a ramp at 1 replica (label `replica_1`).
3. Runs `ALTER SERVICE ... SET MIN_INSTANCES = 2 MAX_INSTANCES = 2` and logs `scaleup_issued`.
   - **If this fails** (for example, the platform refuses to scale block-volume services), the step is recorded as SKIPPED and the procedure exits.
4. Waits for 2 READY vllm instances and logs `second_replica_ready` with the seconds waited. That is the scale-up cold start.
5. Runs the ramp again at 2 replicas (label `replica_2`).
6. **Always restores** the original MIN/MAX.

### Step 6 — finish

- The run status becomes DONE, DONE_WITH_ERRORS, CANCELLED or FAILED, and `FINISHED_AT` is set.
- The app polls every 15 s and refreshes progress and charts.

### Safety layers

| Layer | Mechanism |
|---|---|
| Target scope | Only services in `BENCH_TARGETS` can be tested; the app cannot write to that table (admins only) |
| Disruptive actions | Cold start and scaling require: (1) the target has `ALLOW_DISRUPTIVE = TRUE`, (2) the user types the target name, (3) `EXECUTE_RUN` re-checks both before running |
| SQL injection | All app SQL uses bind variables; procedures regex-validate values before building dynamic SQL |
| Mutual exclusion | Single task instance means one run at a time |
| State restore | The replica test always restores MIN/MAX_INSTANCES |
| Cancel | Sets CANCEL_REQUESTED and drops the current job; the orchestrator stops after the current step |

---

## 7. Timeline of actual operations

### Phase A — Kit and plan (10-28 morning)

1. Wrote the customer test plan `Customer_LLM_Benchmark_Plan.md` (bilingual).
2. Wrote the kit `llm-bench/`:
   - `image/run_bench.sh` and `cold_start.py`
   - `spec/bench_job.yaml`
   - `sql/00_setup.sql` to `03_results.sql`

### Phase B — Discovery in demo-account

3. Connection check: the SQL tool ignored its connection parameter and kept hitting another account.
   - **Switched to the snow CLI** with `-c <demo-connection>`.
   - Confirmed `CURRENT_ACCOUNT() = DEMO_ACCOUNT`, region `AWS_CN_NORTHWEST_1`.
4. Read-only discovery:
   ```sql
   SHOW COMPUTE POOLS;                                   -- found QWEN_MULTI_POOL (GPU_NV_M, MAX_NODES=1)
   SHOW SERVICES IN COMPUTE POOL QWEN_MULTI_POOL;        -- found QWEN_SERVICE
   DESCRIBE SERVICE QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE;   -- read the spec
   SHOW ENDPOINTS IN SERVICE ...;  LIST @MODEL_ARCHIVE_STAGE;
   ```
   Findings:
   - Model is **Qwen3.5-35B-A3B (MoE)** on vLLM 0.26, TP=4, max-model-len 32768.
   - Weights sit on a **150 GiB block volume**, seeded from `@MODEL_ARCHIVE_STAGE` on first start.
   - A `relay` sidecar listens on 8600 (public) and caps max_tokens at 1024. **We benchmark port 8000 directly.**
   - The tokenizer is at the root of `MODEL_ARCHIVE_STAGE`.
5. Wrote the dry-run plan `Qwen_demo-account_Dryrun_Plan.md`.

### Phase C — Dry run r1 (10-28 09:46 – 14:30 UTC)

6. Recorded the original state: pool MIN/MAX 1/1 SUSPENDED; service MIN/MAX 1/1 SUSPENDED.
7. Created `BENCH_CPU_POOL` and granted it to `QWEN_MULTI_ROLE`; granted `EXECUTE TASK`.
8. Created stages and uploaded the scripts. **Reused the server's vLLM image** for the client, with scripts mounted from a stage, so no Docker build was needed.
9. Resumed the pool and service. **First cold start: 16.8 min.** About 4.5 min was the GPU node, 546 s was weight loading, and 95 s was engine init.
10. Smoke test (baseline) found the double-quoting bug (§9), which was fixed.
11. The vLLM startup log in the event table explained the slow decode (`enforce_eager=True` and others).
12. Ran baseline, ramp and shape: about 2h25m, 0 failures.
13. Cold-start restart: 13.1 min.
14. Replica test: `ALTER SERVICE SET MIN_INSTANCES=2` failed with **"Services that contain volumes with 'block' source cannot be scaled"**. This is a platform limit.
15. Restored the account: MAX_NODES back to 1, service and pools suspended, temporary pool and jobs dropped.
16. Wrote the results report `demo-account/Dryrun_Results_r1.md`.

### Phase D — Console app (10-29)

17. Upgraded the snow CLI from 3.23.0 to 3.31.0 (`brew upgrade snowflake-cli`).
18. Rewrote the backend as a generic, parameterised package, `console-backend/setup.sql`, plus `install.sh`. It contains the whitelist, queue, orchestration procedures and task.
19. Re-created `BENCH_CPU_POOL` (initially suspended) and installed the backend.
20. Built the Next.js app (Snowflake App Runtime template) with Runs, New run, Run detail and Targets pages.
21. Engine smoke test 1: **template arguments were rejected** (values must be alphanumeric or JSON). Fixed by passing JSON strings.
22. Engine smoke test 2 (`engine_smoke2`): **the full chain worked**, queue → task → job → results → UI.
23. Back-filled r1 into `BENCH_RUNS` and `BENCH_RUN_LOG` so its results show in the app.
24. Deployed the app.
    - `snow app setup` generated `app.yml` v2, then `snow app deploy` (4 min 22 s) went live at https://<app-endpoint>.
    - **This confirms App Runtime works in the China region.**
25. Added the report section (automatic findings, cross-shape comparison charts, print to PDF) and redeployed in 2 min.
26. Suspended the Qwen service and both pools again.

### Phase E — Performance tuning run r2_cudagraph (11-03)

Trigger: a public benchmark (Millstone: the same Qwen3.5-35B-A3B on 1× H100 SXM with FP8) reports 212 tok/s per request versus 12 tok/s in r1, a 17× gap. Eager mode was the main suspect. Agreed approach: modify `QWEN_SERVICE` in place after backing it up, and keep the new config if it performs well.

27. **Back up the spec**: saved the `DESCRIBE SERVICE` spec locally and to `@BENCH_SPEC_STAGE/backup/` (spec files not included in this repo). Removed the read-only `sha256` lines to produce a directly usable `rollback_spec.yaml`.
28. **First change**: added only `--no-enforce-eager` to `VLLM_EXTRA_ARGS`, applied it with `ALTER SERVICE ... FROM @BENCH_SPEC_STAGE SPECIFICATION_FILE='backup/tuned_spec.yaml'`, and resumed the service.
29. **Startup failed** (09:47): CUDA graphs were enabled, but there was not enough GPU memory. Per A10G: 22 GiB total, 16.5 GiB weights, ~1.3 GiB activations, CUDA graphs estimated at 1.98 GiB, leaving **-0.06 GiB** for the KV cache (`No available memory for the cache blocks`).
30. **Second change**: added `--max-num-seqs 64` (fewer batch sizes to capture as graphs) and raised `GPU_MEMORY_UTILIZATION` from 0.90 to 0.93.
    ```yaml
    GPU_MEMORY_UTILIZATION: "0.93"                              # was 0.90
    VLLM_EXTRA_ARGS: "--no-enforce-eager --max-num-seqs 64"     # was ""
    ```
31. **Started successfully** (10:03, 14 minutes): the event table shows `Graph capturing finished, took 0.70 GiB`, KV cache 1.93 GiB (~190k tokens, previously ~198k), and 43.7 s of torch.compile.
32. **Queued the run**: `INSERT INTO BENCH_RUNS` (run_id `r2_cudagraph`; baseline + ramp + shape; levels 1 2 4 8 16 32; minimum 8 prompts) followed by `EXECUTE TASK BENCH_RUNNER`.
33. **The bench job could not be scheduled**: it stayed PENDING with `Unschedulable due to insufficient memory resources`. `SHOW SERVICES IN COMPUTE POOL BENCH_CPU_POOL` showed another user's service, `USER$<OTHER_USER>.PUBLIC.<OTHER_SERVICE>`, occupying the only node. We did not touch that service; instead we ran `ALTER COMPUTE POOL BENCH_CPU_POOL SET MAX_NODES = 2`, and the job started at 10:45 (about 35 minutes lost).
34. **Run finished** (11:23) with 0 failures.
35. **Cleanup**: set `BENCH_CPU_POOL` MAX_NODES back to 1 (not suspended, because the other user's service still uses it); suspended `QWEN_SERVICE` and `QWEN_MULTI_POOL`; dropped the three `BENCH_R2_CUDAGRAPH_*` job services. **The tuned config was kept.**

Rollback command:
```sql
ALTER SERVICE QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE
  FROM @QWEN_MULTI_DB.QWEN_MULTI_SCH.BENCH_SPEC_STAGE SPECIFICATION_FILE='backup/rollback_spec.yaml';
```

---

## 8. Dry-run results and interpretation

Source: `QWEN_MULTI_DB.QWEN_MULTI_SCH.BENCH_RESULTS`, run_id = `r1`. 818 requests, 0 failures.

### 8.1 Headline numbers

| Item | Result | SLA |
|---|---|---|
| Max SLA concurrency | **0** (no level passes) | – |
| Single-request decode speed | 12.1 tok/s | ≥ 15 ❌ |
| Peak total throughput | 342 tok/s (chat, concurrency 32) | – |
| Cold start: restart | 13.1 min | – |
| Cold start: from fully suspended (incl. GPU node) | 16.8 min | – |
| Replica scaling | Not possible (platform limit) | – |

### 8.2 Concurrency ramp (1024/512)

| Concurrency | TTFT p95 | Per-request tok/s | E2E p95 | Total tok/s |
|---|---|---|---|---|
| 1 | 0.30 s | 12.1 | 46 s | 12 |
| 4 | 1.12 s | 11.6 | 48 s | 45 |
| 8 | 1.82 s | 11.3 | 50 s | 87 |
| 16 | **3.33 s** | 10.4 | 54 s | 164 |
| 32 | **6.86 s** | 9.7 | 60 s | 303 |

### 8.3 Interpretation

1. **Even concurrency 1 fails** because decode runs at only ~12 tok/s (TPOT ≈ 83 ms). The vLLM startup log shows three causes:
   - `enforce_eager=True` disables CUDA Graphs, so every decode step launches many small GPU kernels from the CPU.
   - The 4 A10G cards are connected by **PCIe only (no NVLink)**. vLLM disables its custom all-reduce, so TP=4 needs a slower all-reduce in every layer.
   - There is no tuned MoE kernel config for A10G; the log warns "sub-optimal".
2. **The GPU is far from saturated.**
   - From concurrency 1 to 32, total throughput grows **25×** while per-request speed drops only 20%.
   - The bottleneck is fixed per-step overhead, not compute. That means there is room to optimise; turning off eager mode is usually the biggest lever.
3. **RAG suffers most.**
   - RAG TTFT exceeds 2 s already at concurrency 2. At 32 it is 18× chat's TTFT.
   - Long-prompt prefill blocks everyone else's decode.
   - Recommendation: enable prefix caching (system prompts and documents repeat), and bound the retrieved context length.
4. **Chat E2E is long.**
   - 1,536 tokens at 12 tok/s ≈ 130 s, so even concurrency 1 misses the 30 s target. Long reasoning chains will put Customer in the same position.
   - Recommendation: stream responses in the front end (users see text within ~0.3 s), and cap max_tokens.
5. **Cold start is dominated by weight loading.**
   - Loading took 546 s: about 70 GB read from a block volume provisioned at 125 MiB/s.
   - On-demand scaling is unrealistic. Keep a warm replica, or raise storage throughput.
6. **Block volumes prevent scaling.** This is the most important finding for Customer. If their weights sit on a block volume, they cannot add replicas by raising MIN_INSTANCES. The options are:
   - two independent services behind a load balancer, or
   - moving the weights off block storage.

> ⚠️ **These are not Customer capacity numbers.** This service runs a MoE model (~3B active parameters) with eager mode enabled; Customer runs a dense 32B model. The dry run validates the **method and the tooling**, and it surfaced platform behaviour: block-volume scaling and the cold-start breakdown.

### 8.4 Tuned run r2_cudagraph vs r1

Config change: eager mode off (CUDA graphs on) + `max-num-seqs 64` + `gpu-memory-utilization 0.93`. Source: `BENCH_RESULTS`, run_id `r2_cudagraph`, 0 failures.

**Baseline (concurrency 1)**

| In / out | TPOT p95 r1 → r2 | tok/s per request r1 → r2 | TTFT p95 r1 → r2 | E2E p95 r1 → r2 |
|---|---|---|---|---|
| Short 256 / 256 | 83 → **7.9 ms** | 12.0 → **126.9** | 0.12 → 0.11 s | 22.8 → **2.3 s** |
| Medium 2048 / 512 | 82.9 → **7.9 ms** | 12.1 → **127.0** | 0.59 → 0.57 s | 45.8 → **4.8 s** |
| Long 8192 / 512 | 82.6 → **8.1 ms** | 12.1 → **123.2** | 2.22 → 2.06 s | 48.1 → **6.5 s** |

**Concurrency ramp (1024 / 512)**

| Concurrency | TTFT p95 r1 → r2 | tok/s per request r1 → r2 | E2E p95 r1 → r2 | Total tok/s r1 → r2 | r2 meets SLA |
|---|---|---|---|---|---|
| 1 | 0.30 → 0.28 s | 12.1 → 127.2 | 46.4 → 4.6 s | 12 → 120 | ✅ |
| 2 | 0.57 → 0.46 s | 11.2 → 97.9 | 48.6 → 6.0 s | 23 → 186 | ✅ |
| 4 | 1.12 → 1.00 s | 11.6 → 68.5 | 48.0 → 8.4 s | 45 → 273 | ✅ |
| 8 | 1.82 → 1.64 s | 11.3 → 44.6 | 49.6 → 12.5 s | 87 → 356 | ✅ |
| 16 | 3.33 → 3.04 s | 10.4 → 29.2 | 54.4 → 20.3 s | 164 → 491 | ❌ TTFT only |
| 32 | 6.86 → 6.27 s | 9.7 → 18.1 | 60.0 → 32.7 s | 303 → 611 | ❌ |

**Token shape (concurrency 8 / 32)**

| Shape | Concurrency | TTFT p95 r1 → r2 | tok/s per request r1 → r2 | E2E p95 r1 → r2 | Total tok/s r1 → r2 |
|---|---|---|---|---|---|
| Chat 256 / 1536 | 8 | 0.64 → 0.52 s | 11.6 → 53.4 | 143.8 → 31.4 s | 89 → 417 |
| Chat 256 / 1536 | 32 | 2.20 → 1.94 s | 11.3 → 24.6 | 148.8 → 67.5 s | 342 → 787 |
| RAG 6144 / 256 | 8 | 9.79 → 8.97 s | 7.9 → 15.2 | 39.5 → 22.1 s | 61 → 128 |
| RAG 6144 / 256 | 32 | 39.67 → 41.41 s | 4.5 → 5.7 | 104.1 → 83.7 s | 109 → 144 |

**Interpretation**

1. **One flag gave a 10× gain**: decode went from 83 ms to 8 ms per token, single-request speed from 12 to 127 tok/s, and total throughput at concurrency 32 doubled from 303 to 611 tok/s. Max SLA concurrency on the ramp went from 0 to **8**; at 16 only TTFT (3.04 s) fails.
2. **TTFT barely changed**: CUDA graphs speed up decode only. Prefill is bound by compute and by PCIe communication across the 4 GPUs, so long RAG inputs still have high TTFT. That needs prefix caching or a stronger GPU (H100 + FP8).
3. **Compared with Millstone (1× H100 SXM + FP8)**:

   | Metric | Millstone | r2 | Gap |
   |---|---|---|---|
   | Single-request generation speed | 212 tok/s | ~127 tok/s | ~1.7× (was 17× in r1) |
   | ITL / TPOT | ~5 ms | ~7.9 ms | ~1.6× |
   | Short-input TTFT | 111 ms | 110 ms | Even |
   | 8K-input TTFT | 0.2 s | 2.06 s | ~10× |
   | Prefill speed | ~57,000 tok/s | ~4,000 tok/s (estimated as 8192 tokens ÷ 2.06 s) | ~14× |

   The remaining decode gap is mostly hardware: memory bandwidth, FP8 weights being half the size, and TP=4 synchronising over PCIe. The prefill gap comes from compute: H100 FP8 is roughly 4× four A10Gs in BF16, plus PCIe communication overhead. The methodology also differs: Millstone reports averages while we report p95, and they use 1,024 output tokens per request and test up to 256K context.
4. **Trade-off**: `max-num-seqs 64` caps the service at 64 concurrent requests; any extra requests queue. Keep this limit in mind for production.

---

## 9. Issues found and fixes

| # | Issue | Cause | Fix |
|---|---|---|---|
| 1 | SQL tool's connection parameter ignored; queries hit the wrong account | Tool behaviour | All demo-account work moved to `snow sql -c <demo-connection>`; always check `CURRENT_ACCOUNT()` first |
| 2 | Spec template YAML error `""baseline""` | Values quoted both in the template and in USING | Fixed the quoting |
| 3 | WAIT_READY counted one instance as two | The `relay` sidecar was also counted as READY | Count only the named container (`vllm`) |
| 4 | Template arguments rejected (`must be alphanumeric or valid json`) | Image paths and URLs contain `/` and `:` | Pass every value as a JSON string via `TO_JSON`; placeholders are unquoted in the template |
| 5 | Replica scaling failed | **Platform limit**: services with a block volume cannot change instance count | Procedure records SKIPPED with the reason and restores settings |
| 6 | Duplicate rows in the cold-start view | Join matched two `resume_issued` events | Also match `test='coldstart_restart'` |
| 7 | Each level took too long (12 tok/s per request) | Slow service | Added configurable `MIN_PROMPTS` (minimum requests per level) |
| 8 | Hydration error on the run detail page | A `<div>` badge nested inside a `<p>` | Status badge now renders a `<span>` |
| 9 | `!` in SQL broke zsh commands | zsh history expansion | Put such SQL in a file and run `snow sql -f` |
| 10 | `SYSTEM$GET_SERVICE_LOGS` error | Max 1,000 lines | Request fewer lines, or query the event table |
| 11 | vLLM failed to start after adding only `--no-enforce-eager`: `No available memory for the cache blocks` | CUDA graphs were estimated at 1.98 GiB, leaving -0.06 GiB for the KV cache | Added `--max-num-seqs 64` (graph memory dropped to 0.70 GiB) and set `GPU_MEMORY_UTILIZATION` to 0.93 |
| 12 | r2 bench job stuck in PENDING: `Unschedulable due to insufficient memory resources` | Another user's service, `USER$<OTHER_USER>.PUBLIC.<OTHER_SERVICE>`, occupied the only node in `BENCH_CPU_POOL` | Temporarily set MAX_NODES = 2, then restored it to 1. In customer environments, use a dedicated CPU pool for the bench client and check `SHOW SERVICES IN COMPUTE POOL` before starting |

---

## 10. The one-click console app

**URL**: https://<app-endpoint>
**Object**: `QWEN_MULTI_DB.QWEN_MULTI_SCH.LLM_BENCH_CONSOLE` (Application Service)
**Stack**: Snowflake App Runtime + Next.js. Runs with owner's rights as `QWEN_MULTI_ROLE`.

| Page | What it does | SQL behind it |
|---|---|---|
| `/` Runs | Recent runs and their status | `SELECT ... FROM BENCH_RUNS ORDER BY REQUESTED_AT DESC` |
| `/runs/new` New run | Pick target and tests, set levels and SLA, confirm disruptive tests | Reads `BENCH_TARGETS`; on submit runs `INSERT INTO BENCH_RUNS` and `EXECUTE TASK BENCH_RUNNER` |
| `/runs/[id]` Run detail | **Report** (automatic findings, comparison charts, print to PDF), progress timeline, headline numbers, per-test charts, per-level SLA table, cold start, CSV export, cancel | Reads `BENCH_RUNS`, `BENCH_RUN_LOG`, `BENCH_RESULTS`, `BENCH_COLDSTART` |
| `/targets` Targets | Read-only whitelist | `SELECT ... FROM BENCH_TARGETS` |

**How findings are produced**: rule-based on the measured data, with no LLM involved. Each finding states a measured fact and, where the data supports it, the likely cause. Example: "throughput grew many times while per-request speed barely changed" leads to "GPU not saturated; per-step overhead dominates".

**Deploy commands**:
```bash
snow app setup --app-name=llm_bench_console ...   # generates app.yml (version 2)
snow app deploy -c <demo-connection> --role QWEN_MULTI_ROLE
```

---

## 11. Notes for the Customer rollout

1. **Ask Customer first**:
   - Does production use `--enforce-eager`?
   - Are the weights on a block volume?
   - What are the real `max-model-len` and `max-num-seqs` values?
2. **Prerequisites**:
   - A PoC copy of the service, with its own GPU pool.
   - A CPU pool for the client.
   - Tokenizer files on a stage.
   - A dedicated bench role (not ACCOUNTADMIN).
   - App Runtime enabled, and snow CLI ≥ 3.30.
   - GPU_NV_M quota for 2 nodes, if the replica test is wanted.
3. **Install** following `console-backend/README.md`. It has three steps:
   1. Run `install.sh`.
   2. Register the target.
   3. Deploy the app.
4. **Suggested order**:
   1. A smoke test (ramp only, concurrency 1).
   2. Baseline + ramp + shape (budget 4–5 hours).
   3. Cold start, then replica scaling.
5. **Set expectations**: on GPU_NV_M (A10G over PCIe), a dense 32B model may struggle to reach 15 tok/s per request. Agree up front on one of:
   - whether the SLA can flex;
   - an A/B test with eager mode off;
   - evaluating a larger GPU instance.

   Lessons from r2:
   - **Turning off eager mode is proven to work** (10× on the same hardware). If Customer runs with `--enforce-eager`, removing it should be the first step. Pair it with `--max-num-seqs` and `gpu-memory-utilization` so the KV cache still fits, or the service will not start. A dense 32B model has larger weights, so its KV cache headroom is tighter; do the memory arithmetic first.
   - **Long-input (RAG) TTFT cannot be fixed with flags.** It needs prefix caching, shorter context, or a stronger GPU.
   - **Make sure the bench CPU pool is not shared** with other services, or the job may fail to schedule.
6. **Cost**: the GPU pool bills while active. Run everything in one window and suspend immediately afterwards.

---

## 12. File index

All paths are relative to the repository root:

| File | Contents |
|---|---|
| `llm-bench/Customer_LLM_Benchmark_Plan.md` | Customer test plan (bilingual) |
| `llm-bench/Qwen_demo-account_Dryrun_Plan.md` | Dry-run plan with discovery findings |
| `llm-bench/demo-account/Dryrun_Results_r1.md` | Dry-run results report |
| `llm-bench/image/run_bench.sh` | Client driver (all 5 tests) |
| `llm-bench/image/cold_start.py` | Cold-start probe |
| `llm-bench/image/Dockerfile` | Optional dedicated client image (not needed when reusing the server image) |
| `llm-bench/sql/00–03_*.sql` | First-generation kit (manual / task mode) |
| `llm-bench/demo-account/*` | demo-account variant used for r1 |
| `llm-bench/console-backend/setup.sql` | **Generic backend** (tables, procedures, task) |
| `llm-bench/console-backend/install.sh` | One-command install |
| `llm-bench/console-backend/targets_example.sql` | Target registration example (demo-account + Customer) |
| `llm-bench/console-backend/bench_job_generic.yaml` | Generic job spec template |
| `llm-bench/console-backend/README.md` | **Customer installation guide** |
| `llm-bench-console/` | Console app source (see its README) |
| `llm-bench-console/lib/bench-shared.ts` | SLA logic and findings rules |
| `llm-bench/notebook/LLM_Bench_Notebook.ipynb` | Notebook edition: submit, monitor, analyse and diagnose runs (same backend as the console) |

---

## 13. Glossary

| Term | Meaning |
|---|---|
| SPCS | Snowpark Container Services: run containers inside Snowflake |
| Compute pool | Set of VM nodes for SPCS. GPU_NV_M = 4× NVIDIA A10G 24 GB |
| Service / job service | Long-running service / one-off job that exits when done |
| Instance / replica | One copy of a service; controlled by MIN/MAX_INSTANCES |
| Block volume | Block storage attached to a service, here holding the weights. **Services with one cannot change instance count** |
| Stage volume | A stage mounted into a container as a directory |
| vLLM | Open-source LLM inference engine with an OpenAI-compatible API |
| TP (tensor parallelism) | Splits one model across several GPUs; every layer needs an all-reduce between them |
| Eager mode | `--enforce-eager` disables CUDA Graphs; faster startup, slower decode |
| MoE | Mixture of Experts: only part of the parameters is active per token (Qwen3.5-35B-A3B activates ~3B) |
| Prefill / decode | Processing the input / generating output token by token |
| Prefix caching | Reuses the KV cache for shared prompt prefixes; very effective for RAG and system prompts |
| Snowflake App Runtime | Snowflake's managed web-app runtime (Application Service) |
| Owner's rights | The app's SQL runs as the role that owns the app |
