from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HF_CACHE = ROOT / "checkpoints" / "huggingface"
os.environ.setdefault("HF_HOME", str(HF_CACHE))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(HF_CACHE / "hub"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(HF_CACHE / "transformers"))

import torch
from diffusers import DiffusionPipeline

from model_snapshots import resolve_snapshots

model_path, pipeline_file = resolve_snapshots(
    HF_CACHE / "hub",
    local_files_only=True,
)
pipeline = DiffusionPipeline.from_pretrained(
    str(model_path),
    custom_pipeline=str(pipeline_file),
    torch_dtype=torch.float16,
    cache_dir=str(HF_CACHE / "hub"),
    local_files_only=True,
)
print(f"Loaded offline pipeline: {type(pipeline).__module__}.{type(pipeline).__name__}")
