-- Register PoC targets the console is allowed to test. Admin-only: the console never writes here.
-- NEVER register the production endpoint.

-- demo-account dry-run target
MERGE INTO BENCH_TARGETS t USING (SELECT
  'qwen-demo-account'                                                                     AS TARGET_NAME,
  'QWEN_MULTI_DB.QWEN_MULTI_SCH.QWEN_SERVICE'                                        AS SERVICE_FQN,
  'vllm'                                                                             AS SERVER_CONTAINER,
  'http://qwen-service:8000'                                                         AS BASE_URL,
  'Qwen/Qwen3.5-35B-A3B'                                                             AS MODEL,
  'QWEN_MULTI_DB.QWEN_MULTI_SCH.MODEL_ARCHIVE_STAGE'                                 AS TOKENIZER_STAGE,
  '/models'                                                                          AS TOKENIZER_PATH,
  '/qwen_multi_db/qwen_multi_sch/qwen_multi_model_repo_image/qwen_multimodel:v3'     AS CLIENT_IMAGE,
  'BENCH_CPU_POOL'                                                                   AS CLIENT_POOL,
  TRUE                                                                               AS ALLOW_DISRUPTIVE,
  'Qwen3.5-35B-A3B MoE, GPU_NV_M, demo service (block volume: replica test is skipped)' AS DESCRIPTION
) s ON t.TARGET_NAME = s.TARGET_NAME
WHEN MATCHED THEN UPDATE SET SERVICE_FQN = s.SERVICE_FQN, SERVER_CONTAINER = s.SERVER_CONTAINER, BASE_URL = s.BASE_URL,
  MODEL = s.MODEL, TOKENIZER_STAGE = s.TOKENIZER_STAGE, TOKENIZER_PATH = s.TOKENIZER_PATH, CLIENT_IMAGE = s.CLIENT_IMAGE,
  CLIENT_POOL = s.CLIENT_POOL, ALLOW_DISRUPTIVE = s.ALLOW_DISRUPTIVE, DESCRIPTION = s.DESCRIPTION
WHEN NOT MATCHED THEN INSERT (TARGET_NAME, SERVICE_FQN, SERVER_CONTAINER, BASE_URL, MODEL, TOKENIZER_STAGE, TOKENIZER_PATH,
  CLIENT_IMAGE, CLIENT_POOL, ALLOW_DISRUPTIVE, DESCRIPTION)
VALUES (s.TARGET_NAME, s.SERVICE_FQN, s.SERVER_CONTAINER, s.BASE_URL, s.MODEL, s.TOKENIZER_STAGE, s.TOKENIZER_PATH,
  s.CLIENT_IMAGE, s.CLIENT_POOL, s.ALLOW_DISRUPTIVE, s.DESCRIPTION);

-- Customer example (fill in from DESCRIBE SERVICE of the PoC service):
-- MERGE ... 'llm-poc', 'LLM_BENCH.BENCH.LLM_POC', 'vllm', 'http://llm-poc:8000',
--           '<served-model-name>', 'LLM_BENCH.BENCH.MODEL_STAGE', '/models/<model-dir>',
--           '/llm_bench/bench/repo/vllm-openai:<prod tag>', 'LLM_BENCH_CPU_POOL', TRUE, 'PoC copy of prod'
