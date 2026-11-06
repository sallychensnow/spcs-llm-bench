#!/usr/bin/env bash
# Install / upgrade the LLM Bench Console backend into one schema.
# Usage: ./install.sh -c <snow connection> -r <role> -d <database> -s <schema> -w <warehouse>
set -euo pipefail
while getopts c:r:d:s:w: o; do case $o in
  c) CONN=$OPTARG;; r) ROLE=$OPTARG;; d) DB=$OPTARG;; s) SCH=$OPTARG;; w) WH=$OPTARG;;
  *) echo "usage: $0 -c conn -r role -d db -s schema -w warehouse"; exit 2;; esac; done
: "${CONN:?-c}" "${ROLE:?-r}" "${DB:?-d}" "${SCH:?-s}" "${WH:?-w}"
for v in "$ROLE" "$DB" "$SCH" "$WH"; do [[ $v =~ ^[A-Za-z0-9_$]+$ ]] || { echo "invalid identifier: $v"; exit 2; }; done

HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="$HERE/../image"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CTX=(-c "$CONN" --role "$ROLE" --database "$DB" --schema "$SCH" --warehouse "$WH")

{ printf 'USE ROLE %s; USE WAREHOUSE %s; USE SCHEMA %s.%s;\n' "$ROLE" "$WH" "$DB" "$SCH"
  sed "s/__BENCH_WAREHOUSE__/$WH/" "$HERE/setup.sql"; } > "$TMP/setup.sql"

echo "== objects";  snow sql "${CTX[@]}" -f "$TMP/setup.sql" | grep -E 'successfully|rror' || true
echo "== upload";   for f in "$IMG/run_bench.sh" "$IMG/cold_start.py"; do
                      snow stage copy "${CTX[@]}" --overwrite "$f" @BENCH_SCRIPTS_STAGE | grep -oE 'UPLOADED|SKIPPED' ; done
                    snow stage copy "${CTX[@]}" --overwrite "$HERE/bench_job_generic.yaml" @BENCH_SPEC_STAGE | grep -oE 'UPLOADED|SKIPPED'
echo "done. Next: register targets (targets_example.sql), then deploy the console app."
