#!/usr/bin/env bash
set -euo pipefail

ERA3D_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ERA3D_ROOT

export UV_CACHE_DIR="$ERA3D_ROOT/cache/uv"
export UV_PYTHON_INSTALL_DIR="$ERA3D_ROOT/cache/uv/python"
export HF_HOME="$ERA3D_ROOT/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$ERA3D_ROOT/cache/huggingface/hub"
export TORCH_HOME="$ERA3D_ROOT/cache/torch"
export XDG_CACHE_HOME="$ERA3D_ROOT/cache/xdg"
export CUDA_CACHE_PATH="$ERA3D_ROOT/cache/cuda"
export TMPDIR="$ERA3D_ROOT/cache/tmp"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

mkdir -p \
  "$UV_CACHE_DIR" \
  "$UV_PYTHON_INSTALL_DIR" \
  "$HUGGINGFACE_HUB_CACHE" \
  "$TORCH_HOME" \
  "$XDG_CACHE_HOME" \
  "$CUDA_CACHE_PATH" \
  "$TMPDIR" \
  "$ERA3D_ROOT/checkpoints" \
  "$ERA3D_ROOT/inputs" \
  "$ERA3D_ROOT/outputs" \
  "$ERA3D_ROOT/logs" \
  "$ERA3D_ROOT/tools"
