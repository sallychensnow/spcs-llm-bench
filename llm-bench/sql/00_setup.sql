-- =====================================================================
-- 00_setup.sql  Environment setup  (run as an admin role in the Customer account)
-- PoC objects are isolated from production: own DB, own GPU pool, own service.
-- =====================================================================
USE ROLE ACCOUNTADMIN;   -- or the Customer SPCS admin role

CREATE ROLE IF NOT EXISTS LLM_BENCH_ROLE;
CREATE DATABASE IF NOT EXISTS LLM_BENCH;
CREATE SCHEMA  IF NOT EXISTS LLM_BENCH.BENCH;
GRANT OWNERSHIP ON DATABASE LLM_BENCH TO ROLE LLM_BENCH_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON SCHEMA LLM_BENCH.BENCH TO ROLE LLM_BENCH_ROLE COPY CURRENT GRANTS;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO ROLE LLM_BENCH_ROLE;
GRANT EXECUTE TASK ON ACCOUNT TO ROLE LLM_BENCH_ROLE;

-- PoC GPU pool. MAX_NODES >= 2 is required for test 5 (one GPU_NV_M node per replica).
-- Check GPU quota for the CN region before raising MAX_NODES.
CREATE COMPUTE POOL IF NOT EXISTS LLM_POC_GPU_POOL
  INSTANCE_FAMILY = GPU_NV_M  MIN_NODES = 1  MAX_NODES = 2
  AUTO_RESUME = TRUE  AUTO_SUSPEND_SECS = 3600;

-- Small CPU pool for the benchmark client, so it never competes with the model for a GPU node.
CREATE COMPUTE POOL IF NOT EXISTS LLM_BENCH_CPU_POOL
  INSTANCE_FAMILY = CPU_X64_S  MIN_NODES = 1  MAX_NODES = 1
  AUTO_RESUME = TRUE  AUTO_SUSPEND_SECS = 600;

GRANT USAGE, MONITOR, OPERATE ON COMPUTE POOL LLM_POC_GPU_POOL   TO ROLE LLM_BENCH_ROLE;
GRANT USAGE, MONITOR, OPERATE ON COMPUTE POOL LLM_BENCH_CPU_POOL TO ROLE LLM_BENCH_ROLE;
CREATE WAREHOUSE IF NOT EXISTS LLM_BENCH_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60;
GRANT USAGE ON WAREHOUSE LLM_BENCH_WH TO ROLE LLM_BENCH_ROLE;
GRANT ROLE LLM_BENCH_ROLE TO USER <bench_operator_user>;

USE ROLE LLM_BENCH_ROLE;
USE SCHEMA LLM_BENCH.BENCH;
USE WAREHOUSE LLM_BENCH_WH;

CREATE IMAGE REPOSITORY IF NOT EXISTS REPO;
SHOW IMAGE REPOSITORIES;   -- repository_url -> docker tag/push target

CREATE STAGE IF NOT EXISTS SPEC_STAGE    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
CREATE STAGE IF NOT EXISTS RESULTS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY = (ENABLE = TRUE);
-- Model weights: point the PoC at the SAME weights as prod (copy, or reuse the prod stage/volume).
CREATE STAGE IF NOT EXISTS MODEL_STAGE   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');

-- Upload specs (from a local shell):
--   snow stage copy spec/bench_job.yaml @LLM_BENCH.BENCH.SPEC_STAGE --overwrite
-- Build & push the client image (see image/Dockerfile):
--   docker build --platform linux/amd64 -t <repo_url>/vllm-bench:latest image/
--   snow spcs image-registry login && docker push <repo_url>/vllm-bench:latest
