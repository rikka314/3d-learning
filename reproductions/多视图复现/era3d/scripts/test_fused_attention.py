"""Numerical and CUDA-kernel smoke tests for the Era3D fused SDPA shim."""

from __future__ import annotations

import math

import torch

from inference_entry import _TorchSDPAOps


def explicit_attention(
    query: torch.Tensor,
    key: torch.Tensor,
    value: torch.Tensor,
    bias: torch.Tensor | None,
    scale: float,
) -> torch.Tensor:
    scores = torch.bmm(query, key.transpose(1, 2)) * scale
    if bias is not None:
        scores = scores + bias
    return torch.bmm(scores.softmax(dim=-1), value)


def main() -> None:
    torch.manual_seed(20260826)
    query = torch.randn(4, 7, 16, dtype=torch.float32)
    key = torch.randn(4, 9, 16, dtype=torch.float32)
    value = torch.randn(4, 9, 12, dtype=torch.float32)
    bias = torch.randn(4, 7, 9, dtype=torch.float32) * 0.1
    scale = 0.37

    expected = explicit_attention(query, key, value, bias, scale)
    actual = _TorchSDPAOps.memory_efficient_attention(
        query,
        key,
        value,
        attn_bias=bias,
        scale=scale,
        output_dtype=torch.float32,
    )
    max_abs_error = (actual - expected).abs().max().item()
    print(f"cpu_max_abs_error={max_abs_error:.9g}")
    if max_abs_error > 2e-6:
        raise AssertionError(f"SDPA numerical error too large: {max_abs_error}")

    default_scale_actual = _TorchSDPAOps.memory_efficient_attention(query, key, value)
    default_scale_expected = explicit_attention(
        query,
        key,
        value,
        bias=None,
        scale=1.0 / math.sqrt(query.shape[-1]),
    )
    default_scale_error = (default_scale_actual - default_scale_expected).abs().max().item()
    print(f"cpu_default_scale_max_abs_error={default_scale_error:.9g}")
    if default_scale_error > 2e-6:
        raise AssertionError(f"Default-scale SDPA error too large: {default_scale_error}")

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the Era3D fused-attention smoke test.")

    query_cuda = torch.randn(4, 256, 64, device="cuda", dtype=torch.float16)
    key_cuda = torch.randn(4, 256, 64, device="cuda", dtype=torch.float16)
    value_cuda = torch.randn(4, 256, 64, device="cuda", dtype=torch.float16)
    with torch.nn.attention.sdpa_kernel(torch.nn.attention.SDPBackend.FLASH_ATTENTION):
        output_cuda = _TorchSDPAOps.memory_efficient_attention(
            query_cuda,
            key_cuda,
            value_cuda,
        )
    torch.cuda.synchronize()
    expected_shape = (4, 256, 64)
    if output_cuda.shape != expected_shape:
        raise AssertionError(f"Unexpected CUDA output shape: {tuple(output_cuda.shape)}")
    if output_cuda.dtype != torch.float16:
        raise AssertionError(f"Unexpected CUDA output dtype: {output_cuda.dtype}")
    output_finite = bool(torch.isfinite(output_cuda).all())
    if not output_finite:
        raise AssertionError("CUDA Flash Attention produced NaN or Inf values")
    print(f"cuda_device={torch.cuda.get_device_name(0)}")
    print(f"cuda_capability={torch.cuda.get_device_capability(0)}")
    print(f"cuda_flash_output_shape={tuple(output_cuda.shape)}")
    print(f"cuda_flash_output_dtype={output_cuda.dtype}")
    print(f"cuda_flash_output_finite={output_finite}")

    print("fused_attention_test=PASS")


if __name__ == "__main__":
    main()
