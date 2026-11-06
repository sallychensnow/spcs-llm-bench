-- =====================================================================
-- 01_poc_service.sql  PoC vLLM service (copy of prod config)
-- IMPORTANT: keep vLLM flags IDENTICAL to production (max-model-len, gpu-memory-utilization,
-- tensor-parallel-size, dtype, max-num-seqs ...) — otherwise results don't transfer to prod.
-- Get them with: DESCRIBE SERVICE <prod_service>;  (spec column)
-- =====================================================================
USE ROLE LLM_BENCH_ROLE;
USE SCHEMA LLM_BENCH.BENCH;

CREATE SERVICE IF NOT EXISTS LLM_POC
  IN COMPUTE POOL LLM_POC_GPU_POOL
  MIN_INSTANCES = 1  MAX_INSTANCES = 1
  FROM SPECIFICATION $$
spec:
  containers:
  - name: vllm
    image: /llm_bench/bench/repo/vllm-openai:v0.10.1     # same tag as prod
    args:
    - --model=/models/<model-dir>
    - --served-model-name=<served-model-name>
    - --tensor-parallel-size=4          # GPU_NV_M = 4 x A10G (24GB); match prod
    - --max-model-len=16384             # match prod
    - --gpu-memory-utilization=0.90     # match prod
    - --port=8000
    resources:
      requests: {nvidia.com/gpu: 4}
      limits:   {nvidia.com/gpu: 4}
    volumeMounts:
    - {name: models, mountPath: /models}
    - {name: dshm,   mountPath: /dev/shm}
    readinessProbe: {port: 8000, path: /health}
  endpoints:
  - {name: api, port: 8000, public: false}
  volumes:
  - {name: models, source: "@llm_bench.bench.model_stage"}
  - {name: dshm, source: memory, size: 10Gi}
$$;

SELECT SYSTEM$GET_SERVICE_STATUS('LLM_POC');
SHOW SERVICE INSTANCES IN SERVICE LLM_POC;
-- Internal DNS used by the client: llm-poc:8000  (same schema; else llm-poc.bench.llm-bench.snowflakecomputing.internal)
