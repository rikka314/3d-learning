"""Resolve the exact Hugging Face snapshots used by this reproduction."""

from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download


MODEL_ID = "sudo-ai/zero123plus-v1.2"
MODEL_REVISION = "2da07e89919e1a130c9b5add1584c70c7aa065fd"
PIPELINE_ID = "sudo-ai/zero123plus-pipeline"
PIPELINE_REVISION = "983e66d28a3637ddd8e3e2fd8165cdff32230872"


def resolve_snapshots(cache_dir: Path, *, local_files_only: bool) -> tuple[Path, Path]:
    """Download or resolve the pinned model and executable pipeline snapshots."""
    model_path = Path(
        snapshot_download(
            repo_id=MODEL_ID,
            revision=MODEL_REVISION,
            cache_dir=str(cache_dir),
            local_files_only=local_files_only,
        )
    )
    pipeline_path = Path(
        snapshot_download(
            repo_id=PIPELINE_ID,
            revision=PIPELINE_REVISION,
            cache_dir=str(cache_dir),
            local_files_only=local_files_only,
        )
    )
    pipeline_file = pipeline_path / "pipeline.py"
    if not pipeline_file.is_file():
        raise FileNotFoundError(f"Pinned custom pipeline is missing: {pipeline_file}")
    return model_path, pipeline_file
