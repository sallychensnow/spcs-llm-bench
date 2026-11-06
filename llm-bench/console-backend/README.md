# LLM Bench Console — Installation guide

Two parts. Install them in **one schema in the customer's account**:

1. **Backend**: tables, procedures and the `BENCH_RUNNER` task, plus the bench scripts and job spec on stages.
2. **Console app**: a Snowflake App Runtime app (`../../llm-bench-console`).

Validated on 2026-10-29 in `demo-account` (cn-northwest-1): full chain queue → task → SPCS job → results → UI, and app deployment.

## 0. Prerequisites

| Item | Notes |
|---|---|
| PoC inference service | A **copy** of the production vLLM service (same image, weights and flags), with its own compute pool. Do not test production |
| CPU compute pool for the client | e.g. `CPU_X64_S`, MIN = MAX = 1 |
| Tokenizer files on a stage | `tokenizer.json`, `tokenizer_config.json`, `config.json`. The weights stage works; Hugging Face is not reachable from CN |
| Bench role | Owns the bench schema. Has OPERATE on the PoC service, USAGE on both pools, and `EXECUTE TASK` on the account |
| Snowflake CLI ≥ 3.30 | For `snow app deploy` |
| App Runtime enabled | `SHOW APPLICATION SERVICES` must work in the account |

Example (admin):

```sql
CREATE ROLE IF NOT EXISTS LLM_BENCH_ROLE;
GRANT OWNERSHIP ON SCHEMA LLM_BENCH.BENCH TO ROLE LLM_BENCH_ROLE COPY CURRENT GRANTS;
GRANT USAGE, MONITOR, OPERATE ON COMPUTE POOL LLM_POC_GPU_POOL   TO ROLE LLM_BENCH_ROLE;
GRANT USAGE, MONITOR, OPERATE ON COMPUTE POOL LLM_BENCH_CPU_POOL TO ROLE LLM_BENCH_ROLE;
GRANT OPERATE, MONITOR ON SERVICE LLM_BENCH.BENCH.LLM_POC TO ROLE LLM_BENCH_ROLE;   -- if not owner
GRANT EXECUTE TASK ON ACCOUNT TO ROLE LLM_BENCH_ROLE;
GRANT USAGE ON WAREHOUSE LLM_BENCH_WH TO ROLE LLM_BENCH_ROLE;
-- App Runtime deploy
GRANT CREATE APPLICATION SERVICE, CREATE ARTIFACT REPOSITORY, CREATE STAGE ON SCHEMA LLM_BENCH.BENCH TO ROLE LLM_BENCH_ROLE;
```

## 1. Install the backend

```bash
./install.sh -c <conn> -r LLM_BENCH_ROLE -d LLM_BENCH -s BENCH -w LLM_BENCH_WH
```

Re-running it upgrades everything in place.

## 2. Register the PoC target

Edit `targets_example.sql` (the Customer example is at the bottom), then run it as the bench role. Fill in the values from `DESCRIBE SERVICE <poc>`:

- `BASE_URL`: `http://<service-dns-name>:<api port>`. Use the vLLM port, not a relay/proxy that caps `max_tokens`.
- `MODEL`: must equal `--served-model-name`.
- `CLIENT_IMAGE`: the same vLLM image as the server (path starting with `/db/schema/repo/...`).
- `ALLOW_DISRUPTIVE`: TRUE only for a PoC service.

## 3. Deploy the console

In `llm-bench-console/app.yml`, set `database`, `schema`, `query_warehouse` and the `BENCH_SCHEMA` env var to the bench schema. Then:

```bash
cd llm-bench-console && npm ci && snow app deploy -c <conn> --role LLM_BENCH_ROLE
GRANT USAGE ON APPLICATION SERVICE LLM_BENCH.BENCH.LLM_BENCH_CONSOLE TO ROLE <testers>;
```

## 4. Use

Open the app URL → **New run** → pick the target and tests → **Start run**. Progress and results update automatically, and you can close the browser.

Suggested order:

1. A smoke test: ramp only, levels `1`.
2. Baseline + ramp + shape: several hours, run off-peak.
3. Cold start, then replica scaling.

## Known limits

- **Block-volume services cannot be rescaled.** The replica step is then skipped. To test scaling, use 2 separate services behind a load balancer, or move the weights off block storage.
- One run at a time. Extra runs wait in the queue. If a run stays QUEUED while nothing is running, use **Start runner** on its page.
- Cancelling a run drops the current bench job. A cold-start step that is already in progress still leaves the target resuming.
- The SLA verdict is recomputed in the UI from the thresholds stored with each run. Exported CSVs include it.
