#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HF_HOME="$ROOT/checkpoints/huggingface"
export HUGGINGFACE_HUB_CACHE="$ROOT/checkpoints/huggingface/hub"
export TRANSFORMERS_CACHE="$ROOT/checkpoints/huggingface/transformers"
export XDG_CACHE_HOME="$ROOT/cache/xdg"
export CUDA_CACHE_PATH="$ROOT/cache/cuda"
export TRITON_CACHE_DIR="$ROOT/cache/triton"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Environment missing. Run setup.ps1 first." >&2
  exit 2
fi

"$ROOT/.venv/bin/python" "$ROOT/scripts/download_model.py"
