#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

REPO_URL="https://github.com/pengHTYX/Era3D.git"
COMMIT="a2ce68da53c0dc4df403112c53692b9ba893a4f0"
TARGET="$ERA3D_ROOT/upstream"

if [[ ! -d "$TARGET/.git" ]]; then
  if [[ -e "$TARGET" ]] && [[ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Refusing to replace non-empty non-Git directory: $TARGET" >&2
    exit 1
  fi
  git clone --filter=blob:none "$REPO_URL" "$TARGET"
fi

# The repository lives on an NTFS mount and may also be inspected by Windows Git.
# Use one normalization policy so WSL does not report every CRLF text file dirty.
git -C "$TARGET" config core.autocrlf true

if [[ -n "$(git -C "$TARGET" status --porcelain --untracked-files=no)" ]]; then
  echo "Upstream has tracked local edits; preserve them before changing revisions." >&2
  exit 1
fi

if [[ "$(git -C "$TARGET" rev-parse HEAD)" != "$COMMIT" ]]; then
  git -C "$TARGET" fetch --depth=1 origin "$COMMIT"
  git -C "$TARGET" checkout --detach "$COMMIT"
fi

echo "Era3D upstream: $(git -C "$TARGET" rev-parse HEAD)"
