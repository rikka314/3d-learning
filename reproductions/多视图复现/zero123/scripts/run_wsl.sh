#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HF_HOME="$ROOT/checkpoints/huggingface"
export HUGGINGFACE_HUB_CACHE="$ROOT/checkpoints/huggingface/hub"
export TRANSFORMERS_CACHE="$ROOT/checkpoints/huggingface/transformers"
export TORCH_HOME="$ROOT/cache/torch"
export XDG_CACHE_HOME="$ROOT/cache/xdg"
export CUDA_CACHE_PATH="$ROOT/cache/cuda"
export TRITON_CACHE_DIR="$ROOT/cache/triton"
export TMPDIR="$ROOT/cache/tmp"
mkdir -p "$TMPDIR" "$ROOT/outputs" "$ROOT/logs"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Environment missing. Run setup.ps1 first." >&2
  exit 2
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
log_file="$ROOT/logs/inference-${timestamp}.log"
"$ROOT/.venv/bin/python" "$ROOT/scripts/run_zero123.py" "$@" 2>&1 | tee "$log_file"
