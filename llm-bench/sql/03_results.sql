-- =====================================================================
-- 03_results.sql  Load results + SLA verdict
-- SLA: TTFT p95 < 2s, E2E p95 < 30s, >= 15 output tok/s per request (=> TPOT p95 <= 66.7 ms)
-- =====================================================================
USE ROLE LLM_BENCH_ROLE;
USE SCHEMA LLM_BENCH.BENCH;

CREATE TABLE IF NOT EXISTS BENCH_RAW (file_name STRING, loaded_at TIMESTAMP_LTZ, doc VARIANT);
CREATE FILE FORMAT IF NOT EXISTS JSON_FF TYPE = JSON STRIP_OUTER_ARRAY = FALSE;

CREATE OR REPLACE PROCEDURE LOAD_RESULTS()
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
BEGIN
  COPY INTO BENCH_RAW (file_name, loaded_at, doc)
    FROM (SELECT METADATA$FILENAME, CURRENT_TIMESTAMP(), $1 FROM @RESULTS_STAGE)
    FILE_FORMAT = (FORMAT_NAME = JSON_FF) PATTERN = '.*\\.json';
  RETURN 'loaded';
END;
$$;

-- One row per bench point. Path: <run_id>/<test>/<label>_in<N>_out<M>_c<C>.json
CREATE OR REPLACE VIEW BENCH_RESULTS AS
SELECT
  SPLIT_PART(file_name, '/', 1)                        AS run_id,
  SPLIT_PART(file_name, '/', 2)                        AS test,
  doc:label::STRING                                    AS label,
  TRY_TO_NUMBER(REGEXP_SUBSTR(file_name, '_in(\\d+)_',  1, 1, 'e')) AS input_len,
  TRY_TO_NUMBER(REGEXP_SUBSTR(file_name, '_out(\\d+)_', 1, 1, 'e')) AS output_len,
  doc:max_concurrency::INT                             AS concurrency,
  doc:completed::INT                                   AS completed,
  doc:num_prompts::INT - doc:completed::INT            AS failed,
  doc:request_throughput::FLOAT                        AS req_per_s,
  doc:output_throughput::FLOAT                         AS out_tok_per_s,
  doc:total_token_throughput::FLOAT                    AS total_tok_per_s,
  doc:median_ttft_ms::FLOAT / 1000                     AS ttft_p50_s,
  doc:p95_ttft_ms::FLOAT / 1000                        AS ttft_p95_s,
  doc:p99_ttft_ms::FLOAT / 1000                        AS ttft_p99_s,
  doc:median_tpot_ms::FLOAT                            AS tpot_p50_ms,
  doc:p95_tpot_ms::FLOAT                               AS tpot_p95_ms,
  1000 / NULLIF(doc:p95_tpot_ms::FLOAT, 0)             AS per_req_tok_s_p95,   -- slowest 5% of requests
  doc:median_e2el_ms::FLOAT / 1000                     AS e2e_p50_s,
  doc:p95_e2el_ms::FLOAT / 1000                        AS e2e_p95_s,
  (doc:p95_ttft_ms::FLOAT < 2000
   AND doc:p95_e2el_ms::FLOAT < 30000
   AND doc:p95_tpot_ms::FLOAT <= 1000/15.0
   AND doc:completed::INT = doc:num_prompts::INT)       AS meets_sla
FROM BENCH_RAW
WHERE file_name NOT ILIKE '%coldstart%';

-- Max SLA-compliant concurrency per test/shape (the "capacity" answer)
CREATE OR REPLACE VIEW BENCH_CAPACITY AS
SELECT run_id, test, label, input_len, output_len,
       MAX(IFF(meets_sla, concurrency, NULL))           AS max_sla_concurrency,
       MAX_BY(req_per_s,       IFF(meets_sla, concurrency, -1)) AS req_per_s_at_max,
       MAX_BY(out_tok_per_s,   IFF(meets_sla, concurrency, -1)) AS out_tok_s_at_max
FROM BENCH_RESULTS
WHERE test IN ('ramp', 'shape', 'replica')
GROUP BY ALL;

-- Test 5: throughput gain 1 -> 2 replicas at equal concurrency
CREATE OR REPLACE VIEW BENCH_REPLICA_GAIN AS
SELECT r1.run_id, r1.concurrency,
       r1.out_tok_per_s AS tok_s_1rep, r2.out_tok_per_s AS tok_s_2rep,
       r2.out_tok_per_s / NULLIF(r1.out_tok_per_s, 0) AS scaling_factor,   -- ideal = 2.0
       r1.ttft_p95_s AS ttft_p95_1rep, r2.ttft_p95_s AS ttft_p95_2rep
FROM BENCH_RESULTS r1 JOIN BENCH_RESULTS r2
  ON r1.run_id = r2.run_id AND r1.concurrency = r2.concurrency
 AND r1.label = 'replica_1' AND r2.label = 'replica_2';

-- Test 4: cold start
CREATE OR REPLACE VIEW BENCH_COLDSTART AS
SELECT doc:run_id::STRING run_id, 'restart' mode,
       doc:models_ready_s::FLOAT models_ready_s, doc:first_completion_s::FLOAT first_response_s,
       DATEDIFF('second', l.ts, doc:probe_start_utc::TIMESTAMP_TZ) resume_to_probe_s
FROM BENCH_RAW b LEFT JOIN BENCH_RUN_LOG l
  ON l.run_id = b.doc:run_id::STRING AND l.event = 'resume_issued' AND l.test = 'coldstart_restart'
WHERE file_name ILIKE '%coldstart%'
UNION ALL
SELECT run_id, 'scaleup', NULL, detail:seconds::FLOAT, NULL
FROM BENCH_RUN_LOG WHERE event = 'second_replica_ready';

-- Test 5: per-replica request distribution (needs LOG_LEVEL=INFO on the service + an active event table;
-- counts vLLM uvicorn access-log lines per instance during the 2-replica run window)
-- ALTER SERVICE LLM_POC SET LOG_LEVEL = 'INFO';
SELECT RESOURCE_ATTRIBUTES:"snow.service.container.instance"::STRING AS instance_id,
       COUNT(*) AS requests
FROM SNOWFLAKE.TELEMETRY.EVENTS          -- replace with the account's active event table
WHERE RESOURCE_ATTRIBUTES:"snow.service.name" = 'LLM_POC'
  AND RECORD_TYPE = 'LOG'
  AND VALUE::STRING ILIKE '%POST /v1/completions%'
  AND TIMESTAMP BETWEEN (SELECT MAX(ts) FROM BENCH_RUN_LOG WHERE test='replica' AND replicas=2 AND event='job_start')
                    AND (SELECT MAX(ts) FROM BENCH_RUN_LOG WHERE test='replica' AND replicas=2 AND event='job_end')
GROUP BY 1 ORDER BY 1;

-- Quick looks
-- SELECT * FROM BENCH_RESULTS WHERE test='baseline' ORDER BY input_len;
-- SELECT * FROM BENCH_RESULTS WHERE test='ramp' ORDER BY concurrency;
-- SELECT * FROM BENCH_CAPACITY;  SELECT * FROM BENCH_REPLICA_GAIN;  SELECT * FROM BENCH_COLDSTART;
