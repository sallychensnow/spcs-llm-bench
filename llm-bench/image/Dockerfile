# Reuse the SAME vLLM image/version as the PoC server so the bench client matches.
# Push it to the Customer image repository first (Docker Hub is not reachable from SPCS CN).
ARG VLLM_IMAGE=<orgname>-<acct>.registry.snowflakecomputing.cn/llm_bench/bench/repo/vllm-openai:v0.10.1
FROM ${VLLM_IMAGE}
COPY run_bench.sh cold_start.py /opt/bench/
RUN chmod +x /opt/bench/run_bench.sh
ENTRYPOINT ["/opt/bench/run_bench.sh"]
