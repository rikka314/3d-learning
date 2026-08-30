from __future__ import annotations

import platform

import accelerate
import diffusers
import torch
import transformers
from mvadapter.pipelines.pipeline_mvadapter_i2mv_sd import MVAdapterI2MVSDPipeline


def main() -> None:
    print(f"python={platform.python_version()}")
    print(f"torch={torch.__version__}")
    print(f"cuda_build={torch.version.cuda}")
    print(f"cuda_available={torch.cuda.is_available()}")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the MV-Adapter reproduction.")
    capability = torch.cuda.get_device_capability(0)
    if capability != (12, 0):
        raise RuntimeError(f"Expected RTX 5070 capability (12, 0), got {capability}")
    matrix = torch.randn((256, 256), device="cuda", dtype=torch.float16)
    result = matrix @ matrix
    torch.cuda.synchronize()
    if not bool(torch.isfinite(result).all()):
        raise RuntimeError("CUDA matrix smoke produced non-finite values.")
    print(f"gpu={torch.cuda.get_device_name(0)}")
    print(f"capability={capability}")
    print(f"cuda_matmul_mean={result.float().mean().item():.6f}")
    print(f"diffusers={diffusers.__version__}")
    print(f"transformers={transformers.__version__}")
    print(f"accelerate={accelerate.__version__}")
    print(f"pipeline={MVAdapterI2MVSDPipeline.__name__}")


if __name__ == "__main__":
    main()
