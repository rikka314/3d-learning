#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

VARIANT="${1:-standard}"
case "$VARIANT" in
  standard)
    REPO_ID="pengHTYX/MacLab-Era3D-512-6view"
    REVISION="00732de5cb3417b2a806ced9e92879aacb67c731"
    TARGET="$ERA3D_ROOT/checkpoints/MacLab-Era3D-512-6view"
    ;;
  ortho)
    REPO_ID="pengHTYX/MacLab-Era3D-512-6view-ortho"
    REVISION="ecd72f13232c5ca5ae4e9b927d8917c9bc079886"
    TARGET="$ERA3D_ROOT/checkpoints/MacLab-Era3D-512-6view-ortho"
    ;;
  *)
    echo "Unknown variant '$VARIANT'; use 'standard' or 'ortho'." >&2
    exit 2
    ;;
esac

if [[ ! -x "$ERA3D_ROOT/.venv/bin/python" ]]; then
  echo "Run scripts/setup.ps1 first." >&2
  exit 1
fi

"$ERA3D_ROOT/.venv/bin/python" - "$REPO_ID" "$REVISION" "$TARGET" <<'PY'
import sys
from huggingface_hub import snapshot_download

repo_id, revision, target = sys.argv[1:]
path = snapshot_download(
    repo_id=repo_id,
    revision=revision,
    local_dir=target,
)
print(path)
PY
