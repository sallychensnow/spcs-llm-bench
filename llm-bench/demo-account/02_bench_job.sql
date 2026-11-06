-- =====================================================================
-- 02_bench_job.sql  Run the benchmark job (procedures + task)
-- =====================================================================
USE ROLE QWEN_MULTI_ROLE; USE WAREHOUSE QWEN_MULTI_MODEL_WH;
USE SCHEMA QWEN_MULTI_DB.QWEN_MULTI_SCH;

CREATE TABLE IF NOT EXISTS BENCH_RUN_LOG (
  run_id STRING, test STRING, replicas INT, event STRING, ts TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), detail VARIANT);

-- Run one test as a synchronous SPCS job on the CPU pool.
CREATE OR REPLACE PROCEDURE RUN_BENCH(TEST STRING, RUN_ID STRING, REPLICAS INT,
                                      LEVELS STRING DEFAULT '1 2 4 8 16 32 64')
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE
  job_name STRING := 'BENCH_' || REPLACE(UPPER(:RUN_ID || '_' || :TEST), '-', '_');
  stmt STRING;
BEGIN
  INSERT INTO BENCH_RUN_LOG(run_id, test, replicas, event) VALUES (:RUN_ID, :TEST, :REPLICAS, 'job_start');
  EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS ' || :job_name;
  stmt := 'EXECUTE JOB SERVICE IN COMPUTE POOL BENCH_CPU_POOL NAME = ' || :job_name ||
          ' FROM @BENCH_SPEC_STAGE SPECIFICATION_TEMPLATE_FILE = ''bench_job.yaml''' ||
          ' USING (test => ''' || :TEST || ''', run_id => ''' || :RUN_ID || ''',' ||
          ' replicas => ''' || :REPLICAS || ''', levels => ''' || :LEVELS || ''')';
  EXECUTE IMMEDIATE :stmt;
  INSERT INTO BENCH_RUN_LOG(run_id, test, replicas, event) VALUES (:RUN_ID, :TEST, :REPLICAS, 'job_end');
  RETURN 'done: ' || :job_name || '  logs: SELECT SYSTEM$GET_SERVICE_LOGS(''' || :job_name || ''', 0, ''bench'', 500);';
END;
$$;

-- Wait until N instances of the PoC service are READY; returns seconds waited.
CREATE OR REPLACE PROCEDURE WAIT_READY(N INT, TIMEOUT_S INT DEFAULT 3600, CONTAINER STRING DEFAULT 'vllm')
RETURNS NUMBER LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE t0 TIMESTAMP_LTZ := CURRENT_TIMESTAMP(); ready INT := 0;
BEGIN
  LOOP
    SELECT COUNT(*) INTO :ready
      FROM TABLE(FLATTEN(PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('QWEN_SERVICE'))))
     WHERE value:status::STRING = 'READY' AND value:containerName::STRING = :CONTAINER;  -- one row per container per instance
    IF (ready >= N OR DATEDIFF('second', t0, CURRENT_TIMESTAMP()) > TIMEOUT_S) THEN BREAK; END IF;
    SELECT SYSTEM$WAIT(5);
  END LOOP;
  RETURN DATEDIFF('second', t0, CURRENT_TIMESTAMP());
END;
$$;

-- Test 4: cold start. MODE = 'restart' (suspend+resume, 1 replica) or 'scaleup' (1 -> 2 replicas).
CREATE OR REPLACE PROCEDURE RUN_COLDSTART(RUN_ID STRING, MODE STRING)
RETURNS VARIANT LANGUAGE SQL EXECUTE AS CALLER AS
$$
DECLARE waited NUMBER;
BEGIN
  IF (MODE = 'restart') THEN
    ALTER SERVICE QWEN_SERVICE SUSPEND;
    SELECT SYSTEM$WAIT(60);
    INSERT INTO BENCH_RUN_LOG(run_id, test, replicas, event) VALUES (:RUN_ID, 'coldstart_restart', 1, 'resume_issued');
    ALTER SERVICE QWEN_SERVICE RESUME;
    -- client polls /v1/models then sends the first completion (time-to-first-response)
    CALL RUN_BENCH('coldstart', :RUN_ID, 1);
    waited := 0;
  ELSE
    ALTER SERVICE QWEN_SERVICE SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
    CALL WAIT_READY(1);
    INSERT INTO BENCH_RUN_LOG(run_id, test, replicas, event) VALUES (:RUN_ID, 'coldstart_scaleup', 2, 'scaleup_issued');
    ALTER SERVICE QWEN_SERVICE SET MIN_INSTANCES = 2 MAX_INSTANCES = 2;
    CALL WAIT_READY(2) INTO :waited;   -- includes GPU node provisioning if the pool had 1 node
    INSERT INTO BENCH_RUN_LOG(run_id, test, replicas, event, detail)
      SELECT :RUN_ID, 'coldstart_scaleup', 2, 'second_replica_ready', OBJECT_CONSTRUCT('seconds', :waited);
  END IF;
  RETURN OBJECT_CONSTRUCT('mode', :MODE, 'scaleup_ready_s', :waited);
END;
$$;

-- Full round in order. Run off-peak; total runtime is several hours.
CREATE OR REPLACE PROCEDURE RUN_ALL(RUN_ID STRING)
RETURNS STRING LANGUAGE SQL EXECUTE AS CALLER AS
$$
BEGIN
  ALTER SERVICE QWEN_SERVICE SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
  CALL WAIT_READY(1);
  CALL RUN_BENCH('baseline', :RUN_ID, 1);
  CALL RUN_BENCH('ramp',     :RUN_ID, 1);
  CALL RUN_BENCH('shape',    :RUN_ID, 1);
  CALL RUN_BENCH('replica',  :RUN_ID, 1);
  CALL RUN_COLDSTART(:RUN_ID, 'restart');
  CALL RUN_COLDSTART(:RUN_ID, 'scaleup');          -- leaves service at 2 replicas
  CALL RUN_BENCH('replica',  :RUN_ID, 2, '1 2 4 8 16 32 64 128');
  ALTER SERVICE QWEN_SERVICE SET MIN_INSTANCES = 1 MAX_INSTANCES = 1;
  CALL LOAD_RESULTS();                             -- defined in 03_results.sql
  RETURN 'run ' || :RUN_ID || ' complete';
END;
$$;

-- Snowflake task wrapper (suggested approach). Created suspended; trigger manually.
CREATE OR REPLACE TASK BENCH_ROUND_TASK
  WAREHOUSE = QWEN_MULTI_MODEL_WH
  USER_TASK_TIMEOUT_MS = 43200000      -- 12h
AS
  CALL RUN_ALL('r' || TO_CHAR(CURRENT_TIMESTAMP(), 'YYYYMMDD_HH24MI'));

-- EXECUTE TASK BENCH_ROUND_TASK;
-- Or run single steps interactively, e.g.:
-- CALL RUN_BENCH('baseline', 'r1', 1);
