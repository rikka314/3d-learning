#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

VARIANT="${1:-standard}"
SEED="${2:-600}"
CROP_SIZE="${3:-420}"
DATALOADER_WORKERS="${4:-0}"
DRY_RUN="${5:-0}"

if [[ ! "$DATALOADER_WORKERS" =~ ^[0-9]+$ ]]; then
  echo "Dataloader workers must be a non-negative integer." >&2
  exit 2
fi

case "$VARIANT" in
  standard)
    CONFIG="configs/test_unclip-512-6view.yaml"
    MODEL="$ERA3D_ROOT/checkpoints/MacLab-Era3D-512-6view"
    ;;
  ortho)
    CONFIG="configs/test_unclip-512-6view-ortho.yaml"
    MODEL="$ERA3D_ROOT/checkpoints/MacLab-Era3D-512-6view-ortho"
    ;;
  *)
    echo "Unknown variant '$VARIANT'; use 'standard' or 'ortho'." >&2
    exit 2
    ;;
esac

if [[ ! -x "$ERA3D_ROOT/.venv/bin/python" ]]; then
  echo "Missing .venv; run scripts/setup.ps1 first." >&2
  exit 1
fi
if [[ ! -f "$MODEL/model_index.json" ]]; then
  echo "Missing weights; run scripts/download_weights.ps1 -Variant $VARIANT first." >&2
  exit 1
fi
if ! find "$ERA3D_ROOT/inputs" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.webp' \) -print -quit | grep -q .; then
  echo "Place at least one foreground-isolated RGBA .png or .webp in inputs/." >&2
  exit 1
fi

INFERENCE_COMMAND=(
  "$ERA3D_ROOT/.venv/bin/python"
  "$ERA3D_ROOT/scripts/inference_entry.py"
  --config "$CONFIG"
  "pretrained_model_name_or_path=$MODEL"
  "validation_dataset.root_dir=$ERA3D_ROOT/inputs"
  "validation_dataset.crop_size=$CROP_SIZE"
  "validation_dataset.num_validation_samples=1000"
  "dataloader_num_workers=$DATALOADER_WORKERS"
  "seed=$SEED"
  "save_mode=rgb"
)

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'DRY_RUN_COMMAND='
  printf '%q ' "${INFERENCE_COMMAND[@]}"
  printf '\n'
  exit 0
fi

RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')-${VARIANT}-seed${SEED}"
OUT="$ERA3D_ROOT/outputs/$RUN_ID"
LOG="$ERA3D_ROOT/logs/$RUN_ID.log"
mkdir -p "$OUT"

cd "$ERA3D_ROOT/upstream"
set -o pipefail
"${INFERENCE_COMMAND[@]}" \
  "save_dir=$OUT" \
  2>&1 | tee "$LOG"

echo "Outputs: $OUT"
echo "Log: $LOG"
