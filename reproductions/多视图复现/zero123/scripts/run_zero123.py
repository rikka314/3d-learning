from __future__ import annotations

import argparse
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HF_CACHE = ROOT / "checkpoints" / "huggingface"
os.environ.setdefault("HF_HOME", str(HF_CACHE))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(HF_CACHE / "hub"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(HF_CACHE / "transformers"))
os.environ.setdefault("TORCH_HOME", str(ROOT / "cache" / "torch"))
os.environ.setdefault("CUDA_CACHE_PATH", str(ROOT / "cache" / "cuda"))
os.environ.setdefault("TRITON_CACHE_DIR", str(ROOT / "cache" / "triton"))

import torch
from diffusers import DiffusionPipeline, EulerAncestralDiscreteScheduler
from PIL import Image

from model_snapshots import resolve_snapshots


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the fixed six-view Zero123++ v1.2 grid.")
    parser.add_argument("--input", type=Path, required=True, help="Square RGB/RGBA image (>=320 px recommended).")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--steps", type=int, default=28)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--cpu-offload", action="store_true", help="Reduce VRAM at the cost of speed.")
    parser.add_argument("--offline", action="store_true", help="Use only locally cached model files.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(input_path)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this minimal reproduction.")

    with Image.open(input_path) as source:
        image = source.convert("RGBA" if source.mode == "RGBA" else "RGB")
    if image.width != image.height:
        raise ValueError(f"Input must be square; received {image.width}x{image.height}.")

    model_path, pipeline_file = resolve_snapshots(
        HF_CACHE / "hub",
        local_files_only=args.offline,
    )
    pipeline = DiffusionPipeline.from_pretrained(
        str(model_path),
        custom_pipeline=str(pipeline_file),
        torch_dtype=torch.float16,
        cache_dir=str(HF_CACHE / "hub"),
        local_files_only=True,
    )
    pipeline.scheduler = EulerAncestralDiscreteScheduler.from_config(
        pipeline.scheduler.config,
        timestep_spacing="trailing",
    )
    if args.cpu_offload:
        pipeline.enable_model_cpu_offload()
    else:
        pipeline.to("cuda:0")

    generator = torch.Generator(device="cuda").manual_seed(args.seed)
    result = pipeline(image, num_inference_steps=args.steps, generator=generator).images[0]
    output_path = args.output or ROOT / "outputs" / f"{input_path.stem}_s{args.seed}_n{args.steps}.png"
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path)
    print(f"Saved six-view grid: {output_path}")


if __name__ == "__main__":
    main()
