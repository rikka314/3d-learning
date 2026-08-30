#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

UV_VERSION="0.12.1"
UV_SHA256="90b2f223fb69d19db49e117da601f64978593417988530aa733d456141b4bcbb"
ARCHIVE="$ERA3D_ROOT/cache/downloads/uv-x86_64-unknown-linux-gnu.tar.gz"
EXTRACTED="$ERA3D_ROOT/cache/downloads/uv-x86_64-unknown-linux-gnu/uv"
UV_BIN="$ERA3D_ROOT/tools/uv/uv"

if [[ -x "$UV_BIN" ]] && [[ "$($UV_BIN --version)" == "uv $UV_VERSION "* ]]; then
  exit 0
fi

mkdir -p "$(dirname "$ARCHIVE")" "$(dirname "$UV_BIN")"
if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --location --retry 3 \
    --output "$ARCHIVE" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz"
fi

echo "$UV_SHA256  $ARCHIVE" | sha256sum --check --status
tar -xzf "$ARCHIVE" -C "$(dirname "$ARCHIVE")"
install -m 0755 "$EXTRACTED" "$UV_BIN"
"$UV_BIN" --version

