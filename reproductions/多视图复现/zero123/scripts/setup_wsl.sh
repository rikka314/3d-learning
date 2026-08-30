#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UV_VERSION="0.8.13"
UV_ARCHIVE_SHA256="8ca3db7b2a3199171cfc0870be1f819cb853ddcec29a5fa28dae30278922b7ba"
UV_BIN_SHA256="e88b679ac5dc3a1711a12729e2423f5f7da7c0d03eeb3af97ccea9754330be33"
UV_DIR="$ROOT/.tools/uv"
UV_BIN="$UV_DIR/uv"
EXPECTED_UPSTREAM_COMMIT="7d0315c31be6eb906b34cf07d91310f8e12e9b95"

mkdir -p "$UV_DIR" "$ROOT/cache/uv" "$ROOT/cache/uv-python" "$ROOT/cache/xdg" \
  "$ROOT/checkpoints/huggingface" "$ROOT/inputs" "$ROOT/outputs" "$ROOT/logs"

if [[ ! -d "$ROOT/upstream/.git" ]]; then
  git clone --filter=blob:none https://github.com/SUDO-AI-3D/zero123plus.git "$ROOT/upstream"
  git -C "$ROOT/upstream" checkout --detach "$EXPECTED_UPSTREAM_COMMIT"
fi
actual_upstream_commit="$(git -C "$ROOT/upstream" rev-parse HEAD)"
if [[ "$actual_upstream_commit" != "$EXPECTED_UPSTREAM_COMMIT" ]]; then
  echo "Unexpected upstream commit: $actual_upstream_commit" >&2
  echo "Expected: $EXPECTED_UPSTREAM_COMMIT" >&2
  exit 1
fi

if [[ ! -x "$UV_BIN" ]]; then
  archive="$ROOT/cache/uv/uv-${UV_VERSION}.tar.gz"
  curl --fail --location --retry 3 \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
    --output "$archive"
  printf '%s  %s\n' "$UV_ARCHIVE_SHA256" "$archive" | sha256sum --check --status
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  tar -xzf "$archive" -C "$temp_dir"
  install -m 0755 "$temp_dir/uv-x86_64-unknown-linux-gnu/uv" "$UV_BIN"
  if [[ -f "$temp_dir/uv-x86_64-unknown-linux-gnu/uvx" ]]; then
    install -m 0755 "$temp_dir/uv-x86_64-unknown-linux-gnu/uvx" "$UV_DIR/uvx"
  fi
fi
if [[ "$($UV_BIN --version)" != "uv $UV_VERSION" ]]; then
  echo "Unexpected uv version: $($UV_BIN --version)" >&2
  exit 1
fi
printf '%s  %s\n' "$UV_BIN_SHA256" "$UV_BIN" | sha256sum --check --status

export UV_CACHE_DIR="$ROOT/cache/uv"
export UV_PYTHON_INSTALL_DIR="$ROOT/cache/uv-python"
export XDG_CACHE_HOME="$ROOT/cache/xdg"
export HF_HOME="$ROOT/checkpoints/huggingface"
export HUGGINGFACE_HUB_CACHE="$ROOT/checkpoints/huggingface/hub"
export TRANSFORMERS_CACHE="$ROOT/checkpoints/huggingface/transformers"
export CUDA_CACHE_PATH="$ROOT/cache/cuda"
export TRITON_CACHE_DIR="$ROOT/cache/triton"

cd "$ROOT"
"$UV_BIN" python install 3.11.13 --no-bin
if [[ -f "$ROOT/uv.lock" ]]; then
  "$UV_BIN" sync --frozen --python 3.11.13 --python-preference only-managed
else
  "$UV_BIN" lock --python 3.11.13 --python-preference only-managed
  "$UV_BIN" sync --frozen --python 3.11.13 --python-preference only-managed
fi

"$ROOT/.venv/bin/python" "$ROOT/scripts/doctor.py"
