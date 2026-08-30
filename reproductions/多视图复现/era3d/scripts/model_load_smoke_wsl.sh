#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

MODEL="$ERA3D_ROOT/checkpoints/MacLab-Era3D-512-6view"
if [[ ! -f "$MODEL/model_index.json" ]]; then
  echo "Missing standard weights; run scripts/download_weights.ps1 first." >&2
  exit 1
fi

cd "$ERA3D_ROOT/upstream"
"$ERA3D_ROOT/.venv/bin/python" - "$MODEL" 2>&1 <<'PY' \
  | tee "$ERA3D_ROOT/logs/model-load-smoke.log"
import sys
from collections import Counter
from pathlib import Path

import torch
from mvdiffusion.pipelines.pipeline_mvdiffusion_unclip import StableUnCLIPImg2ImgPipeline

sys.path.insert(0, str(Path.cwd().parent / "scripts"))
from inference_entry import install_fused_sdpa_compat

install_fused_sdpa_compat()

pipeline = StableUnCLIPImg2ImgPipeline.from_pretrained(
    sys.argv[1],
    torch_dtype=torch.float16,
)
pipeline.unet.enable_xformers_memory_efficient_attention()
print("pipeline_load=PASS")
print(f"unet_type={type(pipeline.unet).__name__}")
print(f"unet_dtype={pipeline.unet.dtype}")
print(f"vae_use_slicing={pipeline.vae.use_slicing}")
print(f"vae_use_tiling={pipeline.vae.use_tiling}")
processors = Counter(type(value).__name__ for value in pipeline.unet.attn_processors.values())
print(f"attention_processors={dict(processors)}")
PY
