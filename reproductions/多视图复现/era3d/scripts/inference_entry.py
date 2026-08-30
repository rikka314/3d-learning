"""Run pinned Era3D with local PyTorch SDPA and VAE memory fixes."""

from __future__ import annotations

import os
import runpy
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import torch
import torch.nn.functional as F


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
ENTRYPOINT = UPSTREAM / "test_mvdiffusion_unclip.py"


class _TorchSDPAOps:
    """Subset of ``xformers.ops`` required by Era3D's custom processors."""

    @staticmethod
    def memory_efficient_attention(
        query: torch.Tensor,
        key: torch.Tensor,
        value: torch.Tensor,
        attn_bias: torch.Tensor | None = None,
        p: float = 0.0,
        scale: float | None = None,
        op: Any = None,
        output_dtype: torch.dtype | None = None,
        **kwargs: Any,
    ) -> torch.Tensor:
        del op
        is_causal = bool(kwargs.pop("is_causal", False))
        if kwargs:
            unknown = ", ".join(sorted(kwargs))
            raise TypeError(f"Unsupported memory_efficient_attention arguments: {unknown}")

        if query.ndim == 3:
            query_sdpa = query.unsqueeze(1)
            key_sdpa = key.unsqueeze(1)
            value_sdpa = value.unsqueeze(1)
            restore = lambda tensor: tensor.squeeze(1)
        elif query.ndim == 4:
            query_sdpa = query.transpose(1, 2)
            key_sdpa = key.transpose(1, 2)
            value_sdpa = value.transpose(1, 2)
            restore = lambda tensor: tensor.transpose(1, 2)
        else:
            raise ValueError(f"Expected 3D or 4D attention tensors, got {query.ndim}D")

        mask_sdpa = attn_bias
        if mask_sdpa is not None:
            if not isinstance(mask_sdpa, torch.Tensor):
                raise TypeError("Era3D SDPA shim supports tensor attention biases only")
            if query.ndim == 3 and mask_sdpa.ndim == 3:
                mask_sdpa = mask_sdpa.unsqueeze(1)

        result = F.scaled_dot_product_attention(
            query_sdpa,
            key_sdpa,
            value_sdpa,
            attn_mask=mask_sdpa,
            dropout_p=float(p),
            is_causal=is_causal,
            scale=scale,
        )
        result = restore(result)
        if output_dtype is not None:
            result = result.to(output_dtype)
        return result


_XFORMERS_SHIM = SimpleNamespace(ops=_TorchSDPAOps)


def install_fused_sdpa_compat() -> None:
    """Install process-local attention and VAE memory compatibility patches."""
    if str(UPSTREAM) not in sys.path:
        sys.path.insert(0, str(UPSTREAM))

    from mvdiffusion.models import transformer_mv2d_image
    from mvdiffusion.models import transformer_mv2d_rowwise
    from mvdiffusion.models import transformer_mv2d_self_rowwise
    from mvdiffusion.models.unet_mv2d_condition import UNetMV2DConditionModel
    from mvdiffusion.pipelines.pipeline_mvdiffusion_unclip import (
        StableUnCLIPImg2ImgPipeline,
    )

    transformer_modules = (
        transformer_mv2d_image,
        transformer_mv2d_rowwise,
        transformer_mv2d_self_rowwise,
    )
    for transformer_module in transformer_modules:
        transformer_module.xformers = _XFORMERS_SHIM

    custom_attention_types = tuple(
        attention_type
        for transformer_module in transformer_modules
        for attention_type in (
            transformer_module.CustomAttention,
            transformer_module.CustomJointAttention,
        )
    )

    def enable_fused_custom_attention(
        self: UNetMV2DConditionModel,
        *_args: Any,
        **_kwargs: Any,
    ) -> UNetMV2DConditionModel:
        switched = 0
        for module in self.modules():
            if type(module) in custom_attention_types:
                module.set_use_memory_efficient_attention_xformers(True)
                switched += 1

        processor_counts = Counter(
            type(processor).__name__ for processor in self.attn_processors.values()
        )
        print(
            "Era3D fused SDPA custom attention enabled: "
            f"switched={switched}, processors={dict(processor_counts)}"
        )
        return self

    UNetMV2DConditionModel.enable_xformers_memory_efficient_attention = (
        enable_fused_custom_attention
    )

    if not getattr(StableUnCLIPImg2ImgPipeline, "_era3d_vae_memory_patch", False):
        original_from_pretrained = StableUnCLIPImg2ImgPipeline.from_pretrained

        @classmethod
        def from_pretrained_with_vae_memory(
            _cls: type[StableUnCLIPImg2ImgPipeline],
            *args: Any,
            **kwargs: Any,
        ) -> StableUnCLIPImg2ImgPipeline:
            pipeline = original_from_pretrained(*args, **kwargs)
            pipeline.enable_vae_slicing()
            pipeline.vae.enable_tiling()
            print(
                "Era3D VAE memory optimization enabled: "
                f"slicing={pipeline.vae.use_slicing}, "
                f"tiling={pipeline.vae.use_tiling}"
            )
            return pipeline

        StableUnCLIPImg2ImgPipeline.from_pretrained = from_pretrained_with_vae_memory
        StableUnCLIPImg2ImgPipeline._era3d_vae_memory_patch = True


def main() -> None:
    install_fused_sdpa_compat()
    os.chdir(UPSTREAM)
    sys.argv[0] = str(ENTRYPOINT)
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    try:
        runpy.run_path(str(ENTRYPOINT), run_name="__main__")
    finally:
        if torch.cuda.is_available():
            allocated_mib = torch.cuda.max_memory_allocated() / 1024**2
            reserved_mib = torch.cuda.max_memory_reserved() / 1024**2
            print(
                "Era3D CUDA peak memory: "
                f"allocated={allocated_mib:.0f} MiB, reserved={reserved_mib:.0f} MiB"
            )


if __name__ == "__main__":
    main()
