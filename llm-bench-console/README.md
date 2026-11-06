# LLM Bench Console

A Snowflake App Runtime web app for **one-click capacity benchmarking of vLLM inference services running on Snowpark Container Services**. Validated end to end on the demo-account (cn-northwest-1) Qwen3.5-35B-A3B service.

Pages:

| Page | What it does |
|---|---|
| `/` Runs | Recent runs, status, duration, and counts of active and completed runs |
| `/runs/new` New run | Pick a registered target and the tests (baseline / ramp / shape / cold start / replica), set concurrency levels and SLA thresholds. Cold start and replica tests need a typed-name confirmation |
| `/runs/[id]` Run detail | Live progress per step (refreshes every 15 s), headline numbers (max SLA concurrency, single-request tok/s, peak throughput, cold start), curves with SLA reference lines, a per-point SLA verdict table, cold-start breakdown, CSV export, cancel |
| `/targets` Targets | Read-only list of registered PoC services |

## How it works

The app does not run load itself. It writes a row to `BENCH_RUNS` and runs `EXECUTE TASK BENCH_RUNNER`. The task's `PROCESS_QUEUE` → `EXECUTE_RUN` procedures then:

1. Start the target and wait until it is READY.
2. Run each test as an SPCS job service. The job uses `vllm bench serve` against the target's internal DNS name, with the same vLLM image as the server.
3. Write the result JSON to `@BENCH_RESULTS_STAGE`, load it into `BENCH_RAW`, and expose it through the `BENCH_RESULTS` view.

Runs keep going if the browser is closed. Only one run executes at a time.

The backend SQL, job spec and install script are in `../llm-bench/console-backend/`. The bench scripts are in `../llm-bench/image/`.

## Data sources

All objects are in the schema set by the `BENCH_SCHEMA` environment variable in `app.yml` (demo-account: `QWEN_MULTI_DB.QWEN_MULTI_SCH`):

| Object | Use |
|---|---|
| `BENCH_TARGETS` | Whitelist of testable services. **Read-only for the app**; administrators maintain it |
| `BENCH_RUNS` | Run queue and status. The app inserts rows and sets cancel requests |
| `BENCH_RUN_LOG` | Step start/finish events and the cold-start timing marks |
| `BENCH_RESULTS`, `BENCH_COLDSTART` (views over `BENCH_RAW`) | Benchmark metrics |
| Task `BENCH_RUNNER` | Executes queued runs |

The app runs with **owner's rights**. The role that owns the app service must be able to run the task and the procedures, and to suspend, resume and alter the target services. In practice this is the role that owns the bench schema.

## Safety

- Only services in `BENCH_TARGETS` can be tested. Never register a production endpoint.
- Cold start (SUSPEND/RESUME) and replica scaling (MIN/MAX_INSTANCES) run only when the target has `ALLOW_DISRUPTIVE = TRUE` **and** the user typed the target name in the confirmation dialog. The server checks both again, and so does `EXECUTE_RUN`.
- All user input goes through SQL bind variables. The procedures also validate run IDs, concurrency levels and pool names before building dynamic SQL.
- Services with a `block` volume cannot be rescaled (platform limit). The replica step records this as **skipped** and restores the original MIN/MAX.

## Run locally

```bash
npm install
BENCH_SCHEMA=QWEN_MULTI_DB.QWEN_MULTI_SCH \
SNOWFLAKE_CONNECTION_NAME=<demo-connection> \
SNOWFLAKE_ROLE=QWEN_MULTI_ROLE SNOWFLAKE_WAREHOUSE=QWEN_MULTI_MODEL_WH \
npm run dev
```

Use `npm run dev` or `npm run start`. Never run `node .next/standalone/server.js` locally (static assets will 404).

`npm test` runs the Vitest suite. If `SNOWFLAKE_DEFAULT_CONNECTION_NAME` is set in your shell, unset it first; one template test reads the local toml config.

## Deploy

Deployment config is in `app.yml` (`version: 2`): `database`, `schema`, `query_warehouse`, plus the `BENCH_SCHEMA` env var. Deploy with the role that owns the bench schema:

```bash
snow app deploy -c <connection> --role <bench owner role>
```

The demo-account deployment is `QWEN_MULTI_DB.QWEN_MULTI_SCH.LLM_BENCH_CONSOLE` at https://<app-endpoint>. To share it: `GRANT USAGE ON APPLICATION SERVICE ... TO ROLE <role>`.
