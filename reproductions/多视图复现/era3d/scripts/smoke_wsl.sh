#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common_wsl.sh"

EXPECTED_UPSTREAM="a2ce68da53c0dc4df403112c53692b9ba893a4f0"
ACTUAL_UPSTREAM="$(git -C "$ERA3D_ROOT/upstream" rev-parse HEAD)"
if [[ "$ACTUAL_UPSTREAM" != "$EXPECTED_UPSTREAM" ]]; then
  echo "Unexpected upstream commit: $ACTUAL_UPSTREAM" >&2
  exit 1
fi

cd "$ERA3D_ROOT/upstream"
"$ERA3D_ROOT/.venv/bin/python" - 2>&1 <<'PY' \
  | tee "$ERA3D_ROOT/logs/smoke.log"
import torch
import torch.nn.functional as F
import torchvision
import diffusers
import transformers
from mvdiffusion.data.single_image_dataset import SingleImageDataset
from mvdiffusion.pipelines.pipeline_mvdiffusion_unclip import StableUnCLIPImg2ImgPipeline

print(f"torch={torch.__version__}")
print(f"torchvision={torchvision.__version__}")
print(f"diffusers={diffusers.__version__}")
print(f"transformers={transformers.__version__}")
print(f"cuda_available={torch.cuda.is_available()}")

if not torch.cuda.is_available():
    raise RuntimeError("CUDA is required for the Era3D reproduction.")
capability = torch.cuda.get_device_capability(0)
if capability != (12, 0):
    raise RuntimeError(f"Expected RTX 5070 capability (12, 0), got {capability}")
print(f"device={torch.cuda.get_device_name(0)}")
print(f"capability={capability}")
print(f"arch_list={torch.cuda.get_arch_list()}")
a = torch.randn((256, 256), device="cuda", dtype=torch.float16)
b = a @ a
torch.cuda.synchronize()
if not bool(torch.isfinite(b).all()):
    raise RuntimeError("CUDA matrix smoke produced non-finite values.")
print(f"cuda_matmul_mean={b.float().mean().item():.6f}")
q = torch.randn((1, 8, 64, 64), device="cuda", dtype=torch.float16)
with torch.nn.attention.sdpa_kernel(torch.nn.attention.SDPBackend.FLASH_ATTENTION):
    attention = F.scaled_dot_product_attention(q, q, q)
torch.cuda.synchronize()
if not bool(torch.isfinite(attention).all()):
    raise RuntimeError("Flash SDPA smoke produced non-finite values.")
print(f"sdpa_flash_attention_shape={tuple(attention.shape)}")

print(f"dataset_import={SingleImageDataset.__name__}")
print(f"pipeline_import={StableUnCLIPImg2ImgPipeline.__name__}")
PY
