from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "checkpoints" / "huggingface"
os.environ.setdefault("HF_HOME", str(CACHE))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(CACHE / "hub"))

from model_snapshots import resolve_snapshots


model_path, pipeline_file = resolve_snapshots(CACHE / "hub", local_files_only=False)
print(f"model_snapshot={model_path}")
print(f"custom_pipeline_file={pipeline_file}")
