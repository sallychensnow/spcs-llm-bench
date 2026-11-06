-- =====================================================================
-- LLM Bench Console — backend (generic, idempotent)
-- Run in the bench schema as the bench owner role, e.g.
--   demo-account:  USE ROLE QWEN_MULTI_ROLE; USE SCHEMA QWEN_MULTI_DB.QWEN_MULTI_SCH;
--   Customer:      USE ROLE LLM_BENCH_ROLE; USE SCHEMA LLM_BENCH.BENCH;
-- then register targets with targets_example.sql.
--
-- Flow: app INSERTs a row into BENCH_RUNS (QUEUED) -> EXECUTE TASK BENCH_RUNNER
--   -> PROCESS_QUEUE -> EXECUTE_RUN(run_id) -> one SPCS job per test step
--   -> JSON results on @BENCH_RESULTS_STAGE -> LOAD_RESULTS -> BENCH_RESULTS view.
-- =====================================================================

CREATE STAGE IF NOT EXISTS BENCH_SPEC_STAGE    ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
CREATE STAGE IF NOT EXISTS BENCH_SCRIPTS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
CREATE STAGE IF NOT EXISTS BENCH_RESULTS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE') DIRECTORY = (ENABLE = TRUE);
CREATE FILE FORMAT IF NOT EXISTS JSON_FF TYPE = JSON;

-- Whitelist of services the console may test. Only admins insert here; the app only reads it.
-- Never register a production endpoint. ALLOW_DISRUPTIVE gates suspend/resume and scaling.
CREATE TABLE IF NOT EXISTS BENCH_TARGETS (
  TARGET_NAME      STRING NOT NULL PRIMARY KEY,
  SERVICE_FQN      STRING NOT NULL,          -- DB.SCHEMA.SERVICE of the vLLM PoC service
  SERVER_CONTAINER STRING DEFAULT 'vllm',    -- container name used for readiness checks
  BASE_URL         STRING NOT NULL,          -- e.g. http://qwen-service:8000 (internal DNS, OpenAI API port)
  MODEL            STRING NOT NULL,          -- --served-model-name
  TOKENIZER_STAGE  STRING NOT NULL,          -- stage holding tokenizer files, mounted at /models
  TOKENIZER_PATH   STRING DEFAULT '/models', -- path inside the mount
  CLIENT_IMAGE     STRING NOT NULL,          -- image with vLLM (server image is fine)
  CLIENT_POOL      STRING NOT NULL,          -- CPU compute pool for the bench client
  ALLOW_DISRUPTIVE BOOLEAN DEFAULT FALSE,
  DESCRIPTION      STRING,
  CREATED_AT       TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS BENCH_RUNS (
  RUN_ID             STRING NOT NULL PRIMARY KEY,
  TARGET_NAME        STRING NOT NULL,
  TESTS              ARRAY,                  -- subset of baseline, ramp, shape, coldstart, replica
  LEVELS             STRING,                 -- "1 2 4 8 16 32"
  MIN_PROMPTS        INT DEFAULT 8,
  SLA                OBJECT,                 -- {ttft_p95_s, e2e_p95_s, min_tok_s}
  CONFIRM_DISRUPTIVE BOOLEAN DEFAULT FALSE,
  STATUS             STRING,                 -- QUEUED RUNNING CANCEL_REQUESTED CANCELLED DONE DONE_WITH_ERRORS FAILED
  CURRENT_STEP       STRING,
  CURRENT_JOB        STRING,
  NOTE               STRING,
  REQUESTED_BY       STRING,
  REQUESTED_AT       TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  STARTED_AT         TIMESTAMP_LTZ,
  FINISHED_AT        TIMESTAMP_LTZ,
  ERROR              STRING
);

CREATE TABLE IF NOT EXISTS BENCH_RUN_LOG (
  run_id STRING, test STRING, replicas INT, event STRING,
  ts TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), detail VARIANT);

CREATE TABLE IF NOT EXISTS BENCH_RAW (file_name STRING, loaded_at TIMESTAMP_LTZ, doc VARIANT);

-- ---------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE LOAD_RESULTS()
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
BEGIN
  COPY INTO BENCH_RAW (file_name, loaded_at, doc)
    FROM (SELECT METADATA$FILENAME, CURRENT_TIMESTAMP(), $1 FROM @BENCH_RESULTS_STAGE)
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
  doc:num_prompts::INT                                 AS num_prompts,
  doc:completed::INT                                   AS completed,
  doc:num_prompts::INT - doc:completed::INT            AS failed,
  doc:duration::FLOAT                                  AS duration_s,
  doc:request_throughput::FLOAT                        AS req_per_s,
  doc:output_throughput::FLOAT                         AS out_tok_per_s,
  doc:total_token_throughput::FLOAT                    AS total_tok_per_s,
  doc:median_ttft_ms::FLOAT / 1000                     AS ttft_p50_s,
  doc:p95_ttft_ms::FLOAT / 1000                        AS ttft_p95_s,
  doc:p99_ttft_ms::FLOAT / 1000                        AS ttft_p99_s,
  doc:median_tpot_ms::FLOAT                            AS tpot_p50_ms,
  doc:p95_tpot_ms::FLOAT                               AS tpot_p95_ms,
  1000 / NULLIF(doc:p95_tpot_ms::FLOAT, 0)             AS per_req_tok_s_p95,
  doc:median_e2el_ms::FLOAT / 1000                     AS e2e_p50_s,
  doc:p95_e2el_ms::FLOAT / 1000                        AS e2e_p95_s,
  loaded_at
FROM BENCH_RAW
WHERE file_name NOT ILIKE '%coldstart%';

CREATE OR REPLACE VIEW BENCH_COLDSTART AS
SELECT doc:run_id::STRING AS run_id, 'restart' AS mode,
       doc:models_ready_s::FLOAT AS models_ready_s, doc:first_completion_s::FLOAT AS first_response_s,
       DATEDIFF('second', l.ts, doc:probe_start_utc::TIMESTAMP_TZ) AS resume_to_probe_s
FROM BENCH_RAW b LEFT JOIN BENCH_RUN_LOG l
  ON l.run_id = b.doc:run_id::STRING AND l.event = 'resume_issued' AND l.test = 'coldstart_restart'
WHERE file_name ILIKE '%coldstart%'
UNION ALL
SELECT run_id, 'scaleup', NULL, detail:seconds::FLOAT, NULL
FROM BENCH_RUN_LOG WHERE event = 'second_replica_ready';

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE BENCH_LOG(RUN_ID STRING, TEST STRING, REPLICAS INT, EVENT STRING, DETAIL VARIANT)
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
BEGIN
  INSERT INTO BENCH_RUN_LOG(run_id, test, replicas, event, detail) SELECT :RUN_ID, :TEST, :REPLICAS, :EVENT, :DETAIL;
  RETURN 'ok';
END;
$$;

-- Count READY instances of one container (a sidecar must not double-count an instance).
CREATE OR REPLACE PROCEDURE BENCH_READY_COUNT(SVC STRING, CONTAINER STRING)
RETURNS INT LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE n INT := 0;
BEGIN
  SELECT COUNT(*) INTO :n
    FROM TABLE(FLATTEN(PARSE_JSON(SYSTEM$GET_SERVICE_STATUS(:SVC))))
   WHERE value:status::STRING = 'READY' AND value:containerName::STRING = :CONTAINER;
  RETURN n;
END;
$$;

-- Resume the service if needed and wait until N instances are READY. Returns seconds waited, -1 on timeout.
CREATE OR REPLACE PROCEDURE BENCH_ENSURE_READY(SVC STRING, CONTAINER STRING, N INT, TIMEOUT_S INT, RESUME BOOLEAN)
RETURNS INT LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE t0 TIMESTAMP_LTZ := CURRENT_TIMESTAMP(); ready INT := 0;
BEGIN
  IF (RESUME) THEN
    BEGIN
      EXECUTE IMMEDIATE 'ALTER SERVICE ' || :SVC || ' RESUME';
    EXCEPTION WHEN OTHER THEN NULL;      -- already running
    END;
  END IF;
  LOOP
    CALL BENCH_READY_COUNT(:SVC, :CONTAINER) INTO :ready;
    IF (ready >= N) THEN RETURN DATEDIFF('second', t0, CURRENT_TIMESTAMP()); END IF;
    IF (DATEDIFF('second', t0, CURRENT_TIMESTAMP()) > TIMEOUT_S) THEN RETURN -1; END IF;
    SELECT SYSTEM$WAIT(10);
  END LOOP;
END;
$$;

-- Run one bench step as a synchronous SPCS job. All values come from BENCH_RUNS / BENCH_TARGETS.
CREATE OR REPLACE PROCEDURE RUN_BENCH_JOB(RUN_ID STRING, TEST STRING, REPLICAS INT)
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE
  bad_input EXCEPTION (-20001, 'invalid bench input');
  job_name STRING; stmt STRING; img STRING; url STRING; mdl STRING; tok_stage STRING; tok_path STRING;
  pool STRING; lv STRING; mp INT; here STRING;
BEGIN
  IF (NOT REGEXP_LIKE(RUN_ID, '[A-Za-z0-9_]{1,40}') OR NOT REGEXP_LIKE(TEST, '[a-z]{1,20}')) THEN RAISE bad_input; END IF;
  SELECT t.CLIENT_IMAGE, t.BASE_URL, t.MODEL, t.TOKENIZER_STAGE, t.TOKENIZER_PATH, t.CLIENT_POOL, r.LEVELS, r.MIN_PROMPTS
    INTO :img, :url, :mdl, :tok_stage, :tok_path, :pool, :lv, :mp
    FROM BENCH_RUNS r JOIN BENCH_TARGETS t ON t.TARGET_NAME = r.TARGET_NAME
   WHERE r.RUN_ID = :RUN_ID;
  IF (NOT REGEXP_LIKE(lv, '[0-9]{1,3}( [0-9]{1,3}){0,11}')) THEN RAISE bad_input; END IF;
  IF (NOT REGEXP_LIKE(pool, '[A-Za-z0-9_$."]{1,255}')) THEN RAISE bad_input; END IF;
  here := CURRENT_DATABASE() || '.' || CURRENT_SCHEMA();
  job_name := 'BENCH_' || UPPER(:RUN_ID) || '_' || UPPER(:TEST) || IFF(:TEST = 'replica', '_' || :REPLICAS, '');
  UPDATE BENCH_RUNS SET CURRENT_JOB = :job_name WHERE RUN_ID = :RUN_ID;
  EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS ' || :job_name;
  -- Template argument values must be alphanumeric or valid JSON, so every value is passed as a JSON string
  -- (TO_JSON escapes it) and the spec template uses {{ x }} without surrounding quotes.
  stmt := 'EXECUTE JOB SERVICE IN COMPUTE POOL ' || :pool || ' NAME = ' || :job_name ||
          ' FROM @BENCH_SPEC_STAGE SPECIFICATION_TEMPLATE_FILE = ''bench_job_generic.yaml'' USING (' ||
          'test => '''            || REPLACE(TO_JSON(:TEST::VARIANT), '''', '''''') || ''', ' ||
          'run_id => '''          || REPLACE(TO_JSON(:RUN_ID::VARIANT), '''', '''''') || ''', ' ||
          'replicas => '''        || REPLACE(TO_JSON(:REPLICAS::STRING::VARIANT), '''', '''''') || ''', ' ||
          'levels => '''          || REPLACE(TO_JSON(:lv::VARIANT), '''', '''''') || ''', ' ||
          'min_prompts => '''     || REPLACE(TO_JSON(:mp::STRING::VARIANT), '''', '''''') || ''', ' ||
          'image => '''           || REPLACE(TO_JSON(:img::VARIANT), '''', '''''') || ''', ' ||
          'base_url => '''        || REPLACE(TO_JSON(:url::VARIANT), '''', '''''') || ''', ' ||
          'model => '''           || REPLACE(TO_JSON(:mdl::VARIANT), '''', '''''') || ''', ' ||
          'tokenizer_stage => ''' || REPLACE(TO_JSON(('@' || :tok_stage)::VARIANT), '''', '''''') || ''', ' ||
          'tokenizer_path => '''  || REPLACE(TO_JSON(:tok_path::VARIANT), '''', '''''') || ''', ' ||
          'scripts_stage => '''   || REPLACE(TO_JSON(('@' || :here || '.BENCH_SCRIPTS_STAGE')::VARIANT), '''', '''''') || ''', ' ||
          'results_stage => '''   || REPLACE(TO_JSON(('@' || :here || '.BENCH_RESULTS_STAGE')::VARIANT), '''', '''''') || ''')';
  EXECUTE IMMEDIATE :stmt;
  RETURN :job_name;
END;
$$;

-- Test 4: suspend + resume the target, then measure time to first response.
CREATE OR REPLACE PROCEDURE BENCH_COLDSTART_RESTART(RUN_ID STRING, SVC STRING, CONTAINER STRING)
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE w INT;
BEGIN
  EXECUTE IMMEDIATE 'ALTER SERVICE ' || :SVC || ' SUSPEND';
  SELECT SYSTEM$WAIT(60);
  CALL BENCH_LOG(:RUN_ID, 'coldstart_restart', 1, 'resume_issued', NULL);
  EXECUTE IMMEDIATE 'ALTER SERVICE ' || :SVC || ' RESUME';
  CALL RUN_BENCH_JOB(:RUN_ID, 'coldstart', 1);      -- probe polls /v1/models then first completion
  CALL BENCH_ENSURE_READY(:SVC, :CONTAINER, 1, 600, FALSE) INTO :w;
  RETURN 'ok';
END;
$$;

-- Test 5: ramp at 1 replica, scale to 2 (records scale-up time), ramp again, restore.
-- Services with a block volume cannot be scaled (platform limit); that is recorded as SKIPPED.
CREATE OR REPLACE PROCEDURE BENCH_REPLICA(RUN_ID STRING, SVC STRING, CONTAINER STRING)
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE orig_min INT; orig_max INT; waited INT; msg STRING := '';
  replica_failed EXCEPTION (-20002, 'replica step failed');
BEGIN
  EXECUTE IMMEDIATE 'DESCRIBE SERVICE ' || :SVC;
  SELECT "min_instances", "max_instances" INTO :orig_min, :orig_max FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
  CALL RUN_BENCH_JOB(:RUN_ID, 'replica', 1);
  CALL LOAD_RESULTS();
  BEGIN
    CALL BENCH_LOG(:RUN_ID, 'coldstart_scaleup', 2, 'scaleup_issued', NULL);
    EXECUTE IMMEDIATE 'ALTER SERVICE ' || :SVC || ' SET MIN_INSTANCES = 2 MAX_INSTANCES = 2';
  EXCEPTION WHEN OTHER THEN
    CALL BENCH_LOG(:RUN_ID, 'replica', 2, 'scale_unsupported', OBJECT_CONSTRUCT('error', :SQLERRM));
    RETURN 'SKIPPED: ' || :SQLERRM;
  END;
  BEGIN
    CALL BENCH_ENSURE_READY(:SVC, :CONTAINER, 2, 2700, FALSE) INTO :waited;
    IF (waited < 0) THEN
      msg := 'second replica not READY within 45 min (check GPU pool MAX_NODES / quota)';
    ELSE
      CALL BENCH_LOG(:RUN_ID, 'coldstart_scaleup', 2, 'second_replica_ready', OBJECT_CONSTRUCT('seconds', :waited));
      CALL RUN_BENCH_JOB(:RUN_ID, 'replica', 2);
    END IF;
  EXCEPTION WHEN OTHER THEN
    msg := :SQLERRM;
  END;
  EXECUTE IMMEDIATE 'ALTER SERVICE ' || :SVC || ' SET MIN_INSTANCES = ' || :orig_min || ' MAX_INSTANCES = ' || :orig_max;
  IF (msg <> '') THEN
    CALL BENCH_LOG(:RUN_ID, 'replica', 2, 'replica_error', OBJECT_CONSTRUCT('error', :msg));
    RAISE replica_failed;
  END IF;
  RETURN 'ok';
END;
$$;

-- ---------------------------------------------------------------------
-- Orchestration
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE EXECUTE_RUN(RUN_ID STRING)
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE
  tests ARRAY; confirm BOOLEAN; allow BOOLEAN; svc STRING; cont STRING; st STRING; step STRING;
  plan ARRAY := ARRAY_CONSTRUCT('baseline', 'ramp', 'shape', 'coldstart', 'replica');
  failures INT := 0; waited INT; res STRING;
BEGIN
  SELECT r.TESTS, r.CONFIRM_DISRUPTIVE, t.ALLOW_DISRUPTIVE, t.SERVICE_FQN, t.SERVER_CONTAINER
    INTO :tests, :confirm, :allow, :svc, :cont
    FROM BENCH_RUNS r JOIN BENCH_TARGETS t ON t.TARGET_NAME = r.TARGET_NAME WHERE r.RUN_ID = :RUN_ID;
  UPDATE BENCH_RUNS SET STATUS = 'RUNNING', STARTED_AT = CURRENT_TIMESTAMP(), CURRENT_STEP = 'warmup' WHERE RUN_ID = :RUN_ID;
  CALL BENCH_LOG(:RUN_ID, 'warmup', 1, 'step_start', NULL);
  CALL BENCH_ENSURE_READY(:svc, :cont, 1, 2700, TRUE) INTO :waited;
  IF (waited < 0) THEN
    UPDATE BENCH_RUNS SET STATUS = 'FAILED', FINISHED_AT = CURRENT_TIMESTAMP(), ERROR = 'target service not READY within 45 min'
     WHERE RUN_ID = :RUN_ID;
    CALL BENCH_LOG(:RUN_ID, 'warmup', 1, 'step_failed', OBJECT_CONSTRUCT('error', 'not READY within 45 min'));
    RETURN 'FAILED';
  END IF;
  CALL BENCH_LOG(:RUN_ID, 'warmup', 1, 'step_done', OBJECT_CONSTRUCT('seconds', :waited));

  FOR i IN 0 TO 4 DO
    step := GET(plan, i)::STRING;
    IF (ARRAY_CONTAINS(step::VARIANT, tests)) THEN
      SELECT STATUS INTO :st FROM BENCH_RUNS WHERE RUN_ID = :RUN_ID;
      IF (st = 'CANCEL_REQUESTED') THEN BREAK; END IF;
      IF (step IN ('coldstart', 'replica') AND NOT (COALESCE(confirm, FALSE) AND COALESCE(allow, FALSE))) THEN
        CALL BENCH_LOG(:RUN_ID, :step, 1, 'step_skipped', OBJECT_CONSTRUCT('reason', 'disruptive tests not allowed for this target or not confirmed'));
        CONTINUE;
      END IF;
      UPDATE BENCH_RUNS SET CURRENT_STEP = :step WHERE RUN_ID = :RUN_ID;
      CALL BENCH_LOG(:RUN_ID, :step, 1, 'step_start', NULL);
      BEGIN
        res := 'ok';
        CASE (step)
          WHEN 'baseline'  THEN CALL RUN_BENCH_JOB(:RUN_ID, 'baseline', 1);
          WHEN 'ramp'      THEN CALL RUN_BENCH_JOB(:RUN_ID, 'ramp', 1);
          WHEN 'shape'     THEN CALL RUN_BENCH_JOB(:RUN_ID, 'shape', 1);
          WHEN 'coldstart' THEN CALL BENCH_COLDSTART_RESTART(:RUN_ID, :svc, :cont);
          WHEN 'replica'   THEN CALL BENCH_REPLICA(:RUN_ID, :svc, :cont) INTO :res;
        END CASE;
        CALL LOAD_RESULTS();
        IF (STARTSWITH(res, 'SKIPPED')) THEN
          CALL BENCH_LOG(:RUN_ID, :step, 1, 'step_skipped', OBJECT_CONSTRUCT('reason', :res));
        ELSE
          CALL BENCH_LOG(:RUN_ID, :step, 1, 'step_done', NULL);
        END IF;
      EXCEPTION WHEN OTHER THEN
        failures := failures + 1;
        CALL BENCH_LOG(:RUN_ID, :step, 1, 'step_failed', OBJECT_CONSTRUCT('error', :SQLERRM));
        BEGIN CALL LOAD_RESULTS(); EXCEPTION WHEN OTHER THEN NULL; END;
      END;
    END IF;
  END FOR;

  SELECT STATUS INTO :st FROM BENCH_RUNS WHERE RUN_ID = :RUN_ID;
  UPDATE BENCH_RUNS
     SET STATUS = CASE WHEN :st = 'CANCEL_REQUESTED' THEN 'CANCELLED'
                       WHEN :failures > 0 THEN 'DONE_WITH_ERRORS' ELSE 'DONE' END,
         CURRENT_STEP = NULL, CURRENT_JOB = NULL, FINISHED_AT = CURRENT_TIMESTAMP()
   WHERE RUN_ID = :RUN_ID;
  RETURN 'finished';
END;
$$;

-- Drains the queue one run at a time (only one task instance can run, so runs never overlap).
CREATE OR REPLACE PROCEDURE PROCESS_QUEUE()
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE rid STRING; n INT := 0;
BEGIN
  LOOP
    SELECT MIN_BY(RUN_ID, REQUESTED_AT) INTO :rid FROM BENCH_RUNS WHERE STATUS = 'QUEUED';
    IF (rid IS NULL) THEN BREAK; END IF;
    BEGIN
      CALL EXECUTE_RUN(:rid);
    EXCEPTION WHEN OTHER THEN
      UPDATE BENCH_RUNS SET STATUS = 'FAILED', ERROR = :SQLERRM, FINISHED_AT = CURRENT_TIMESTAMP() WHERE RUN_ID = :rid;
    END;
    n := n + 1;
  END LOOP;
  RETURN n || ' run(s) processed';
END;
$$;

-- No schedule: the console triggers it with EXECUTE TASK. Uses a warehouse only while runs execute.
CREATE OR REPLACE TASK BENCH_RUNNER
  WAREHOUSE = __BENCH_WAREHOUSE__        -- replaced by install.sh
  USER_TASK_TIMEOUT_MS = 86400000
AS
  CALL PROCESS_QUEUE();
