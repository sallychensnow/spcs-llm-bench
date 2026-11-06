-- Test 5: per-replica request distribution (needs LOG_LEVEL=INFO on the service + an active event table;
-- counts vLLM uvicorn access-log lines per instance during the 2-replica run window)
-- ALTER SERVICE QWEN_SERVICE SET LOG_LEVEL = 'INFO';
SELECT RESOURCE_ATTRIBUTES:"snow.service.container.instance"::STRING AS instance_id,
       COUNT(*) AS requests
FROM <EVENT_DB>.<EVENT_SCHEMA>.<EVENT_TABLE>   -- your account event table
WHERE RESOURCE_ATTRIBUTES:"snow.service.name" = 'QWEN_SERVICE'
  AND RECORD_TYPE = 'LOG'
  AND VALUE::STRING ILIKE '%POST /v1/completions%'
  AND TIMESTAMP BETWEEN (SELECT MAX(ts) FROM BENCH_RUN_LOG WHERE test='replica' AND replicas=2 AND event='job_start')
                    AND (SELECT MAX(ts) FROM BENCH_RUN_LOG WHERE test='replica' AND replicas=2 AND event='job_end')
GROUP BY 1 ORDER BY 1;
