#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"
bash "$ERA3D_ROOT/scripts/fetch_upstream_wsl.sh"
bash "$ERA3D_ROOT/scripts/bootstrap_uv_wsl.sh"

UV="$ERA3D_ROOT/tools/uv/uv"
PYTHON_VERSION="3.11.13"

"$UV" python install --no-bin "$PYTHON_VERSION"
if [[ ! -x "$ERA3D_ROOT/.venv/bin/python" ]]; then
  "$UV" venv \
    --python "$PYTHON_VERSION" \
    --python-preference only-managed \
    "$ERA3D_ROOT/.venv"
fi

"$UV" pip sync \
  --python "$ERA3D_ROOT/.venv/bin/python" \
  --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cu128 \
  --require-hashes \
  "$ERA3D_ROOT/requirements-lock.txt"

"$UV" pip check --python "$ERA3D_ROOT/.venv/bin/python"
"$UV" pip freeze --python "$ERA3D_ROOT/.venv/bin/python" \
  | tee "$ERA3D_ROOT/logs/environment-freeze.txt"

echo "Era3D inference environment is ready: $ERA3D_ROOT/.venv"
