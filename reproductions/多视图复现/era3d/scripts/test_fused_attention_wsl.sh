#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

cd "$ERA3D_ROOT/scripts"
"$ERA3D_ROOT/.venv/bin/python" test_fused_attention.py 2>&1 \
  | tee "$ERA3D_ROOT/logs/fused-attention-test.txt"
