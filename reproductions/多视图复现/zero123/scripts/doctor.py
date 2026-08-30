from __future__ import annotations

import json
import os
import platform
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "checkpoints" / "huggingface"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(ROOT / "checkpoints" / "huggingface" / "transformers"))
os.environ.setdefault("TORCH_HOME", str(ROOT / "cache" / "torch"))
os.environ.setdefault("CUDA_CACHE_PATH", str(ROOT / "cache" / "cuda"))
os.environ.setdefault("TRITON_CACHE_DIR", str(ROOT / "cache" / "triton"))

import diffusers
import huggingface_hub
import torch
import torchvision
import transformers


report = {
    "python": platform.python_version(),
    "torch": torch.__version__,
    "torchvision": torchvision.__version__,
    "diffusers": diffusers.__version__,
    "transformers": transformers.__version__,
    "huggingface_hub": huggingface_hub.__version__,
    "cuda_available": torch.cuda.is_available(),
    "cuda_runtime": torch.version.cuda,
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "cuda_capability": torch.cuda.get_device_capability(0) if torch.cuda.is_available() else None,
    "hf_home": os.environ["HF_HOME"],
}
print(json.dumps(report, ensure_ascii=False, indent=2))

if not torch.cuda.is_available():
    raise SystemExit("CUDA is not available inside WSL.")

matrix = torch.randn((256, 256), device="cuda", dtype=torch.float16)
result = matrix @ matrix
torch.cuda.synchronize()
if not bool(torch.isfinite(result).all()):
    raise RuntimeError("CUDA matrix smoke produced non-finite values.")
print(f"cuda_matmul_mean={result.float().mean().item():.6f}")
