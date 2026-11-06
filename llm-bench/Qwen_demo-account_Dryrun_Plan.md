# Internal Dry-run Plan: demo-account Qwen on SPCS

**Account**: `<demo-connection>` (Snowflake China, AWS Ningxia) · **Pool**: `QWEN_MULTI_POOL` (GPU_NV_M, currently Suspended, MAX_NODES = 1)
**Purpose**: Before going to Customer, run the full kit in `llm-bench/` end to end in our own China account to:
1. Confirm the kit works in the CN region: SPCS job service, stage volume mount, `SPECIFICATION_TEMPLATE_FILE`, the result JSON fields for this vLLM version, and event-table logs.
2. Collect a reference curve for GPU_NV_M, so we know roughly what to expect when Customer runs it.
3. Measure how long the full round takes and how much it costs, so we can give Customer a test window and a budget.

> **Important:** this service runs **Qwen3.5-35B-A3B (MoE, ~3B active parameters per token)**. Customer runs **a dense ~32B model**. With the same GPU_NV_M / TP=4, the MoE model decodes much faster, so **throughput, TPOT and max SLA concurrency do not transfer to Customer**. This round validates the **kit and process** (plus cold start / scaling behaviour). Do not quote these numbers to Customer as capacity. If we need numbers close to Customer, run one extra round with a dense 32B model (see §5).

---

## 0. Discovery — ✅ done 2026-10-28 (snow CLI `-c <demo-connection>`)

| Item | Actual value | Effect on the kit |
|---|---|---|
| Service | `QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE` (owner `QWEN_MULTI_ROLE`, SUSPENDED, MIN=MAX=1) | Replace `LLM_POC` with this service |
| Pool | `QWEN_MULTI_POOL` GPU_NV_M, MIN=MAX_NODES=1, owner ACCOUNTADMIN, placement_group A | Test 5 needs `MAX_NODES=2` |
| Runtime | Raw vLLM (`vllm` container) + `relay` sidecar (8600, public, caps max_tokens at 1024) | **Benchmark port 8000 directly, not the relay** |
| Model | `Qwen/Qwen3.5-35B-A3B` (multimodal MoE), TP=4, gpu-mem 0.90, max-model-len 32768 | `MODEL=Qwen/Qwen3.5-35B-A3B`; 8K/6K prompts fit |
| Image | `.../qwen_multi_model_repo_image/qwen_multimodel:v3` (custom build) | Build the bench client `FROM` this image; first check it has `vllm bench` |
| Internal DNS | `qwen-service.oag5.svc.spcs.internal:8000`. In the same schema, `qwen-service:8000` works | `BASE_URL` |
| Weights | `block` volume 150Gi, seeded from `@MODEL_ARCHIVE_STAGE` on first start (~70GB, `SEED_ARCHIVE=auto`) | Cold start includes seeding (see §4) |
| Tokenizer | `@QWEN_MULTI_DB.QWEN_MULTI_SCH.MODEL_ARCHIVE_STAGE` root (`tokenizer.json`, `tokenizer_config.json`, `config.json`) | Mount this stage at `/models`, `TOKENIZER=/models` |
| Other users | `QWEN_UI_SVC` (QWEN_UI_POOL) and the public relay depend on it. The image registry belongs to `<org>-<account>` | **Check with the owner before testing; nobody should be using it during the run** |

Discovery SQL, for reference:

```sql
SELECT CURRENT_ACCOUNT(), CURRENT_REGION();                 -- must not be another account / AP_NORTHEAST_1
DESCRIBE COMPUTE POOL QWEN_MULTI_POOL;
SHOW SERVICES IN COMPUTE POOL QWEN_MULTI_POOL;              -- find the Qwen service FQN
DESCRIBE SERVICE <qwen_service>;                            -- spec: image tag, model, TP, max-model-len, port
SHOW ENDPOINTS IN SERVICE <qwen_service>;
SHOW MODELS IN ACCOUNT;                                     -- if served via Model Registry instead of raw vLLM
```

**Go/No-go**: ✅ This is vLLM's OpenAI-compatible endpoint, so the kit can be used directly.

## 1. Setup

- **Location**: put the bench objects in `QWEN_MULTI_DB.QWEN_MULTI_SCH` and run them as `QWEN_MULTI_ROLE`. Same schema means the short DNS name `qwen-service` resolves, and the role can already read `MODEL_ARCHIVE_STAGE`. New objects: `RESULTS_STAGE`, `BENCH_RUN_LOG`, `BENCH_RAW`, the views, and a `BENCH_CPU_POOL` (CPU_X64_S). Alternatively reuse the idle `SPCS_API_POOL` (CPU_X64_XS, owner QWEN_ROLE), but XS may be too small for 128 concurrent requests.
- **Resume**: `ALTER COMPUTE POOL QWEN_MULTI_POOL RESUME;` → `ALTER SERVICE QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE RESUME;` → wait for READY. The relay and UI don't need to be running.
- **Test 5**: `ALTER COMPUTE POOL QWEN_MULTI_POOL SET MAX_NODES = 2;` (needs ACCOUNTADMIN). Check GPU_NV_M quota in cn-northwest-1 first. If quota isn't enough, skip 4b and 5, and record that as something Customer should know.
- **Bench client image**: `FROM .../qwen_multi_model_repo_image/qwen_multimodel:v3`, so the vLLM version matches the server. Before building, `docker run --entrypoint vllm <img> bench serve --help` to check the image includes the bench subcommand.
- **Kit parameter changes**:
  - `spec/bench_job.yaml`: `BASE_URL=http://qwen-service:8000`, `MODEL=Qwen/Qwen3.5-35B-A3B`, `TOKENIZER=/models`, models volume `@QWEN_MULTI_DB.QWEN_MULTI_SCH.MODEL_ARCHIVE_STAGE`, image path `/qwen_multi_db/qwen_multi_sch/qwen_multi_model_repo_image/vllm-bench:latest`
  - `02_bench_job.sql`: `LLM_POC` → `QWEN_SERVICE`, `LLM_BENCH_CPU_POOL` → `BENCH_CPU_POOL`
  - Skip `00_setup.sql` (except the CPU pool and results stage) and `01_poc_service.sql`
- **Record the original state** so it can be restored: pool MIN/MAX_NODES = 1/1, service MIN/MAX_INSTANCES = 1/1, both SUSPENDED

## 2. Run order

| Step | Command | Pass check |
|---|---|---|
| Smoke | `CALL RUN_BENCH('baseline','dry_smoke',1, '1');` → `CALL LOAD_RESULTS();` | `BENCH_RESULTS` has rows, TTFT/TPOT/E2E are not NULL (checks the JSON field names) |
| T1 Baseline | `RUN_BENCH('baseline', ...)` | 3 rows: short/medium/long |
| T2 Ramp | `RUN_BENCH('ramp', ...)` | Curve reaches a point that fails the target (otherwise extend `LEVELS`) |
| T3 Shape | `RUN_BENCH('shape', ...)` | rag / chat each have one full curve |
| T4a Restart | `RUN_COLDSTART(run,'restart')` | `BENCH_COLDSTART` has models_ready_s and first_response_s |
| T4b Scale-up | `RUN_COLDSTART(run,'scaleup')` | `second_replica_ready` is logged (only if MAX_NODES = 2) |
| T5 Replica | `RUN_BENCH('replica', run, 2, '1 … 128')` | `BENCH_REPLICA_GAIN` has data; event table shows requests on both instances |
| Full | `EXECUTE TASK BENCH_ROUND_TASK;` | Task finishes on its own; record total runtime |

Restore afterwards: `MIN/MAX_INSTANCES` back to their original values, `MAX_NODES` back to 1, then suspend both pools.

## 3. Outputs

- **Kit fixes**: anything broken in CN (syntax, mounts, field names, permissions) is fixed directly in `llm-bench/`
- **GPU_NV_M reference data**: concurrency that meets the target per workload shape, peak throughput, cold-start times, 2-replica scaling factor
- **Customer execution notes**: test window (total runtime), GPU cost (node-hours), quota prerequisites, known pitfalls

## 4. Risks

| Risk | Mitigation |
|---|---|
| QWEN_SERVICE is a shared demo (UI + public relay); the owner is the <account> project | Confirm with the owner before testing, and pick an idle window |
| **Block volume + SEED_ARCHIVE**: a new replica creates a fresh 150Gi block volume and copies ~70GB of weights from the stage | T4b/T5 scale-up will be much slower than T4a restart (existing volume). Record "first seed" separately from "restart with existing volume". the customer's weight mount may be different, so T4 results only show the method |
| `executeAsCaller: true` | The bench job role needs the right grants; running as QWEN_MULTI_ROLE avoids this |
| `allowInternetEgress: true` with HUGGING_FACE_INTEGRATION | If the stage seed fails, vLLM may try to download from HF. Check the logs during cold start |
| Not enough GPU quota for 2 nodes | Do T1–T4a first; T4b/T5 can wait for quota |
| Model size/config differs from Customer | Use the numbers only as reference; what we mainly validate is the process |
| Suspended pool takes several minutes to start the first node | That time is exactly what T4 measures, so record it |
| GPU cost | Run everything in one session and suspend right after |

## 5. Optional round 2 closer to Customer

To get GPU_NV_M numbers comparable to the customer's: in the same pool, create a temporary service `QWEN_DENSE_POC` running a dense ~32B model (for example Qwen2.5-32B-Instruct) with the same image. Mirror the customer's production flags, suspend `QWEN_SERVICE` while it runs, and run the kit again. The weights (~65GB) have to be uploaded to a stage first; HF access in CN may not be reliable.

**Target SLA used for pass/fail (same as Customer)**: TTFT p95 < 2s · E2E p95 < 30s · ≥ 15 tok/s per request · 0 failed requests.
