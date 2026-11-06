# spcs-llm-bench

Capacity benchmarking kit for **vLLM inference services running on Snowpark Container Services (SPCS)**, plus a one-click web console built on **Snowflake App Runtime**.

Everything runs inside the Snowflake account. The load generator (`vllm bench serve`) runs as an SPCS job and calls the model over internal service DNS. Results land on a stage, get loaded into tables, and are analysed with SQL views and the console.

## What it measures

| # | Test | Answers |
|---|---|---|
| 1 | Baseline | Best-case TTFT / TPOT / end-to-end latency at concurrency 1 for short, medium and long prompts |
| 2 | Concurrency ramp | Highest concurrency that still meets the SLA, and peak throughput |
| 3 | Token shape | RAG (long input, short output) vs chat (short input, long output) |
| 4 | Cold start | Time from suspend → resume (or scale-up) to the first response |
| 5 | Replica scaling | Throughput at 1 vs 2 replicas (`MIN_INSTANCES`) |

The default SLA is TTFT p95 < 2 s, E2E p95 < 30 s, ≥ 15 output tok/s per request, and 0 errors. Thresholds are configurable per run.

## Repository layout

| Path | Contents |
|---|---|
| [`llm-bench/console-backend/`](llm-bench/console-backend/) | **Start here.** Generic backend (`setup.sql`), `install.sh`, target registration example, job spec template, installation guide |
| [`llm-bench-console/`](llm-bench-console/) | Next.js console app (Snowflake App Runtime): start runs, live progress, charts, SLA verdicts, auto-generated report, CSV export |
| [`llm-bench/notebook/`](llm-bench/notebook/) | Notebook edition (Snowflake Workspace): pre-flight checks, submit and monitor runs, SLA analysis, comparison charts, vLLM log diagnostics. Same backend as the console |
| [`llm-bench/image/`](llm-bench/image/) | Bench client scripts: `run_bench.sh` (all tests) and `cold_start.py` |
| [`llm-bench/sql/`, `llm-bench/spec/`](llm-bench/sql/) | First-generation kit (manual / task mode, no app) |
| [`llm-bench/demo-account/`](llm-bench/demo-account/) | The variant used for the dry run, and its results report |
| [`llm-bench/Benchmark_Overview_EN.md`](llm-bench/Benchmark_Overview_EN.md) | Full design and operations walkthrough (English). |
| `llm-bench/*_Plan.md` | Customer test plan and dry-run plan templates |

## Quick start

```bash
# 1. Backend (as the role that owns the bench schema)
cd llm-bench/console-backend
./install.sh -c <connection> -r <BENCH_ROLE> -d <DB> -s <SCHEMA> -w <WAREHOUSE>
#    then edit and run targets_example.sql to register your PoC vLLM service

# 2. Console app (Snowflake CLI >= 3.30)
cd ../../llm-bench-console
#    set database / schema / query_warehouse and BENCH_SCHEMA in app.yml
npm ci && snow app deploy -c <connection> --role <BENCH_ROLE>
```

See [`llm-bench/console-backend/README.md`](llm-bench/console-backend/README.md) for prerequisites and grants.

## Safety notes

- **Only test a PoC copy of the service, never production.** The console can only target services an administrator registered in `BENCH_TARGETS`.
- Cold-start and replica tests suspend/resume or rescale the target. They run only when the target has `ALLOW_DISRUPTIVE = TRUE` **and** the user types the target name to confirm.
- Services with a `block` volume cannot change instance count (platform limit). The replica test records this as skipped.

## Notes

- Dry-run numbers in `llm-bench/demo-account/` come from a MoE model with `--enforce-eager` on a GPU_NV_M pool. They illustrate the method and are not capacity figures for any other model.
- Not an official Snowflake product. Provided as-is.
