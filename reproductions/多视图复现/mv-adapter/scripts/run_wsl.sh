#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
MODE="i2mv"
IMAGE=""
MESH=""
OUTPUT="outputs/mv-adapter-sd21.png"
PROMPT="high quality anatomical teaching model"
STEPS="50"
SEED="0"
BASE_MODEL="$ROOT/cache/huggingface/hub/models--sd2-community--stable-diffusion-2-1-base/snapshots/4e63672c03103b6c636b8fb4119ba982469b2955"
ADAPTER_PATH="$ROOT/cache/huggingface/hub/models--huanngzh--mv-adapter/snapshots/6de4033df6b53366f3c009d22f5ec434bb55e59f"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --mesh) MESH="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --steps) STEPS="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --base-model) BASE_MODEL="$2"; shift 2 ;;
    --adapter-path) ADAPTER_PATH="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

export HF_HOME="$ROOT/cache/huggingface"
export TORCH_HOME="$ROOT/cache/torch"
export XDG_CACHE_HOME="$ROOT/cache/xdg"
export TRANSFORMERS_CACHE="$ROOT/cache/huggingface/transformers"
export PYTHONPATH="$ROOT/upstream${PYTHONPATH:+:$PYTHONPATH}"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Environment missing. Run scripts/setup.ps1 first." >&2
  exit 1
fi
if [[ ! -f "$BASE_MODEL/model_index.json" ]]; then
  echo "Pinned base model snapshot is missing: $BASE_MODEL" >&2
  echo "Run scripts/setup.ps1 to download the locked snapshots." >&2
  exit 1
fi
if [[ ! -f "$ADAPTER_PATH/mvadapter_i2mv_sd21.safetensors" ]]; then
  echo "Pinned adapter snapshot is missing: $ADAPTER_PATH" >&2
  echo "Run scripts/setup.ps1 to download the locked snapshots." >&2
  exit 1
fi

resolve_path() {
  if [[ "$1" = /* ]]; then printf '%s\n' "$1"; else printf '%s\n' "$ROOT/$1"; fi
}

if [[ -z "$IMAGE" ]]; then
  if [[ "$MODE" == "ig2mv" ]]; then
    IMAGE="upstream/assets/demo/ig2mv/1ccd5c1563ea4f5fb8152eac59dabd5c.jpeg"
  else
    IMAGE="upstream/assets/demo/i2mv/A_decorative_figurine_of_a_young_anime-style_girl.png"
  fi
fi
IMAGE="$(resolve_path "$IMAGE")"
OUTPUT="$(resolve_path "$OUTPUT")"
mkdir -p "$(dirname -- "$OUTPUT")"

cd "$ROOT/upstream"
if [[ "$MODE" == "i2mv" ]]; then
  "$ROOT/.venv/bin/python" -m scripts.inference_i2mv_sd \
    --image "$IMAGE" --text "$PROMPT" --output "$OUTPUT" \
    --base_model "$BASE_MODEL" --adapter_path "$ADAPTER_PATH" \
    --num_inference_steps "$STEPS" --seed "$SEED" --scheduler ddpm
elif [[ "$MODE" == "ig2mv" ]]; then
  if [[ -z "$MESH" ]]; then
    MESH="upstream/assets/demo/ig2mv/1ccd5c1563ea4f5fb8152eac59dabd5c.glb"
  fi
  MESH="$(resolve_path "$MESH")"
  if [[ ! -f "$ADAPTER_PATH/mvadapter_ig2mv_sd21.safetensors" ]]; then
    echo "Pinned ig2mv adapter weight is missing: $ADAPTER_PATH" >&2
    exit 1
  fi
  "$ROOT/.venv/bin/python" -m scripts.inference_ig2mv_sd \
    --image "$IMAGE" --mesh "$MESH" --text "$PROMPT" --output "$OUTPUT" \
    --base_model "$BASE_MODEL" --adapter_path "$ADAPTER_PATH" \
    --num_inference_steps "$STEPS" --seed "$SEED" --scheduler ddpm
else
  echo "Unsupported mode: $MODE (expected i2mv or ig2mv)" >&2
  exit 2
fi
