#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
UV_VERSION="0.8.13"
UV_ARCHIVE_SHA256="8ca3db7b2a3199171cfc0870be1f819cb853ddcec29a5fa28dae30278922b7ba"
UV_BIN_SHA256="e88b679ac5dc3a1711a12729e2423f5f7da7c0d03eeb3af97ccea9754330be33"
PYTHON_VERSION="3.10.18"
UV_DIR="$ROOT/.tools/uv"
UV="$UV_DIR/uv"
PYTHON="$ROOT/.venv/bin/python"
EXPECTED_UPSTREAM_COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"

export UV_CACHE_DIR="$ROOT/cache/uv"
export UV_PYTHON_INSTALL_DIR="$ROOT/.tools/python"
export UV_NO_PROGRESS=1
export UV_HTTP_TIMEOUT=300
export UV_HTTP_RETRIES=5
export PIP_CACHE_DIR="$ROOT/cache/pip"
export HF_HOME="$ROOT/cache/huggingface"
export TORCH_HOME="$ROOT/cache/torch"
export XDG_CACHE_HOME="$ROOT/cache/xdg"
export PYTHONPATH="$ROOT/upstream${PYTHONPATH:+:$PYTHONPATH}"

mkdir -p "$ROOT/.tools" "$ROOT/cache" "$ROOT/checkpoints" \
  "$ROOT/inputs" "$ROOT/outputs" "$ROOT/logs"

if [[ ! -d "$ROOT/upstream/.git" ]]; then
  git clone --filter=blob:none https://github.com/huanngzh/MV-Adapter.git "$ROOT/upstream"
  git -C "$ROOT/upstream" checkout --detach "$EXPECTED_UPSTREAM_COMMIT"
fi
ACTUAL_UPSTREAM_COMMIT="$(git -C "$ROOT/upstream" rev-parse HEAD)"
if [[ "$ACTUAL_UPSTREAM_COMMIT" != "$EXPECTED_UPSTREAM_COMMIT" ]]; then
  echo "Unexpected upstream commit: $ACTUAL_UPSTREAM_COMMIT" >&2
  echo "Expected: $EXPECTED_UPSTREAM_COMMIT" >&2
  exit 1
fi

PATCH_FILE="$ROOT/patches/i2mv-optional-nvdiffrast.patch"
if git -C "$ROOT/upstream" apply --reverse --check --ignore-space-change "$PATCH_FILE" >/dev/null 2>&1; then
  : # Patch is already applied.
elif git -C "$ROOT/upstream" apply --check --ignore-space-change "$PATCH_FILE"; then
  git -C "$ROOT/upstream" apply --ignore-space-change "$PATCH_FILE"
else
  echo "Unable to apply or verify local patch: $PATCH_FILE" >&2
  exit 1
fi

if [[ ! -x "$UV" ]]; then
  UV_ARCHIVE="$ROOT/cache/uv-${UV_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
  curl --fail --location --retry 3 \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
    --output "$UV_ARCHIVE"
  printf '%s  %s\n' "$UV_ARCHIVE_SHA256" "$UV_ARCHIVE" | sha256sum --check --status
  mkdir -p "$UV_DIR"
  tar --extract --gzip --file "$UV_ARCHIVE" \
    --strip-components=1 --directory "$UV_DIR" \
    uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx
fi
if [[ "$($UV --version)" != "uv $UV_VERSION" ]]; then
  echo "Unexpected uv version: $($UV --version)" >&2
  exit 1
fi
printf '%s  %s\n' "$UV_BIN_SHA256" "$UV" | sha256sum --check --status

"$UV" python install "$PYTHON_VERSION"
if [[ ! -x "$PYTHON" ]]; then
  "$UV" venv --python "$PYTHON_VERSION" "$ROOT/.venv"
fi
actual_python_version="$($PYTHON -c 'import platform; print(platform.python_version())')"
if [[ "$actual_python_version" != "$PYTHON_VERSION" ]]; then
  echo "Unexpected virtualenv Python: $actual_python_version (expected $PYTHON_VERSION)" >&2
  exit 1
fi

"$UV" pip sync --python "$PYTHON" --require-hashes \
  "$ROOT/requirements-lock.txt" \
  --index-url https://pypi.org/simple \
  --extra-index-url https://download.pytorch.org/whl/cu128 \
  --index-strategy unsafe-best-match

"$PYTHON" - "$HF_HOME/hub" <<'PY'
from pathlib import Path
import sys

from huggingface_hub import snapshot_download

cache_dir = Path(sys.argv[1])
base = snapshot_download(
    repo_id="sd2-community/stable-diffusion-2-1-base",
    revision="4e63672c03103b6c636b8fb4119ba982469b2955",
    allow_patterns=(
        ".gitattributes",
        "README.md",
        "model_index.json",
        "feature_extractor/*",
        "scheduler/*",
        "text_encoder/config.json",
        "text_encoder/model.safetensors",
        "tokenizer/*",
        "unet/config.json",
        "unet/diffusion_pytorch_model.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.safetensors",
    ),
    cache_dir=cache_dir,
)
adapter = snapshot_download(
    repo_id="huanngzh/mv-adapter",
    revision="6de4033df6b53366f3c009d22f5ec434bb55e59f",
    allow_patterns=(
        "mvadapter_i2mv_sd21.safetensors",
        "mvadapter_ig2mv_sd21.safetensors",
    ),
    cache_dir=cache_dir,
)
print(f"base_model_snapshot={base}")
print(f"adapter_snapshot={adapter}")
PY

"$PYTHON" "$ROOT/tests/test_optional_nvdiffrast.py" | tee "$ROOT/logs/optional-nvdiffrast-test.log"
"$PYTHON" "$ROOT/scripts/smoke_import.py" | tee "$ROOT/logs/import-smoke.log"
"$UV" pip check --python "$PYTHON" | tee "$ROOT/logs/pip-check.log"
