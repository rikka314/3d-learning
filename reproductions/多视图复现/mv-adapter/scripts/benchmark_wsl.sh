#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TAG="i2mv-sd21"
STEPS="1"
SEED="0"
OFFLINE="0"
BASE_MODEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --steps) STEPS="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --offline) OFFLINE="1"; shift ;;
    --base-model) BASE_MODEL="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

CONSOLE_LOG="$ROOT/logs/${TAG}.console.log"
GPU_LOG="$ROOT/logs/${TAG}.gpu.csv"
TIME_LOG="$ROOT/logs/${TAG}.time.txt"
SUMMARY_LOG="$ROOT/logs/${TAG}.summary.txt"
OUTPUT="$ROOT/outputs/${TAG}.png"
BASELINE_MIB="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | tr -d '[:space:]')"

if [[ "$OFFLINE" == "1" ]]; then
  export HF_HUB_OFFLINE=1
  export TRANSFORMERS_OFFLINE=1
fi

nvidia-smi \
  --query-gpu=timestamp,memory.used,utilization.gpu \
  --format=csv,noheader,nounits --loop-ms=250 > "$GPU_LOG" &
MONITOR_PID=$!
cleanup() {
  kill "$MONITOR_PID" 2>/dev/null || true
  wait "$MONITOR_PID" 2>/dev/null || true
}
trap cleanup EXIT

RUN_ARGS=(
  --mode i2mv --steps "$STEPS" --seed "$SEED"
  --output "$OUTPUT"
  --prompt "A decorative figurine of a young anime-style girl"
)
if [[ -n "$BASE_MODEL" ]]; then
  RUN_ARGS+=(--base-model "$BASE_MODEL")
fi

set +e
(
  /usr/bin/time --format='elapsed_seconds=%e\nmax_rss_kb=%M' --output="$TIME_LOG" \
    bash "$SCRIPT_DIR/run_wsl.sh" "${RUN_ARGS[@]}"
) 2>&1 | tee "$CONSOLE_LOG"
RUN_STATUS=${PIPESTATUS[0]}
set -e

cleanup
trap - EXIT

PEAK_MIB="$(awk -F',' '
  { value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); if (value+0 > max) max=value+0 }
  END { print max+0 }
' "$GPU_LOG")"
DELTA_MIB=$((PEAK_MIB - BASELINE_MIB))
OUTPUT_BYTES=0
if [[ -f "$OUTPUT" ]]; then OUTPUT_BYTES="$(stat --format='%s' "$OUTPUT")"; fi

{
  echo "tag=$TAG"
  echo "status=$RUN_STATUS"
  echo "steps=$STEPS"
  echo "seed=$SEED"
  echo "offline=$OFFLINE"
  echo "base_model=${BASE_MODEL:-pinned-default}"
  echo "baseline_gpu_mib=$BASELINE_MIB"
  echo "peak_total_gpu_mib=$PEAK_MIB"
  echo "approx_process_delta_mib=$DELTA_MIB"
  cat "$TIME_LOG"
  echo "output=$OUTPUT"
  echo "output_bytes=$OUTPUT_BYTES"
} | tee "$SUMMARY_LOG"

exit "$RUN_STATUS"
