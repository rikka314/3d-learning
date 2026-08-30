from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
VALID_MODES = {"vision-context", "camera-aware"}
VIEW_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SHA256_PATTERN = re.compile(r"^[A-Fa-f0-9]{64}$")


class ReferenceSetError(ValueError):
    pass


def _is_finite_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _valid_solved_camera(camera: object) -> bool:
    if not isinstance(camera, dict) or camera.get("solved") is not True:
        return False
    fov = camera.get("fovDegrees")
    aspect = camera.get("aspect")
    orientation = camera.get("orientation")
    position = camera.get("positionHint")
    return (
        _is_finite_number(fov)
        and 0 < float(fov) < 180
        and _is_finite_number(aspect)
        and float(aspect) > 0
        and isinstance(orientation, dict)
        and all(_is_finite_number(orientation.get(axis)) for axis in ("yaw", "pitch", "roll"))
        and isinstance(position, list)
        and len(position) == 3
        and all(_is_finite_number(value) for value in position)
    )


def _is_remote_path(value: str) -> bool:
    return "://" in value or value.startswith(("data:", "blob:"))


def _parse_reference(entry: str | Path, index: int) -> dict[str, Any]:
    raw = str(entry)
    view_id = "primary" if index == 0 else f"view-{index + 1}"
    path = raw
    if "=" in raw:
        candidate_id, candidate_path = raw.split("=", 1)
        if candidate_id.strip() and candidate_path.strip():
            view_id = candidate_id.strip()
            path = candidate_path.strip()
    return {"id": view_id, "role": view_id, "path": path}


def _load_manifest(manifest: dict[str, Any] | str | Path) -> tuple[dict[str, Any], Path]:
    if isinstance(manifest, dict):
        return deepcopy(manifest), Path.cwd()
    path = Path(manifest).expanduser().resolve()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ReferenceSetError(f"reference-set manifest does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise ReferenceSetError(f"reference-set manifest is not valid JSON: {path}") from error
    if not isinstance(payload, dict):
        raise ReferenceSetError("reference-set manifest must be a JSON object")
    return payload, path.parent


def _resolve_path(raw: object, base_dir: Path) -> tuple[str, Path | None]:
    if not isinstance(raw, (str, Path)) or not str(raw).strip():
        raise ReferenceSetError("every referenceSet view requires a non-empty path")
    value = str(raw).strip()
    if _is_remote_path(value):
        return value, None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = base_dir / candidate
    resolved = candidate.resolve()
    return str(resolved), resolved


def _content_hash(path: Path | None) -> str:
    if path is None or not path.is_file():
        return ""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_reference_set(
    references: Iterable[str | Path] | str | Path | None = None,
    manifest: dict[str, Any] | str | Path | None = None,
    *,
    require_files: bool = False,
) -> dict[str, Any]:
    if references is not None and manifest is not None:
        raise ReferenceSetError("provide references or manifest, not both")

    if manifest is not None:
        payload, base_dir = _load_manifest(manifest)
        raw_views = payload.get("views")
        schema_version = payload.get("schemaVersion", SCHEMA_VERSION)
        mode = payload.get("mode", "vision-context")
        primary_view_id = payload.get("primaryViewId")
    else:
        if references is None:
            raise ReferenceSetError("at least one reference image is required")
        if isinstance(references, (str, Path)):
            entries = [references]
        else:
            entries = list(references)
        raw_views = [_parse_reference(entry, index) for index, entry in enumerate(entries)]
        schema_version = SCHEMA_VERSION
        mode = "vision-context"
        primary_view_id = raw_views[0]["id"] if raw_views else None
        base_dir = Path.cwd()

    if schema_version != SCHEMA_VERSION:
        raise ReferenceSetError(f"unsupported referenceSet schemaVersion: {schema_version!r}")
    if mode not in VALID_MODES:
        raise ReferenceSetError("referenceSet mode must be vision-context or camera-aware")
    if not isinstance(raw_views, list) or not raw_views:
        raise ReferenceSetError("referenceSet.views must be a non-empty array")

    normalized_views: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    seen_hashes: set[str] = set()
    for index, raw_view in enumerate(raw_views):
        if not isinstance(raw_view, dict):
            raise ReferenceSetError(f"referenceSet.views[{index}] must be an object")
        view_id = str(raw_view.get("id") or "").strip()
        if not view_id:
            raise ReferenceSetError(f"referenceSet.views[{index}].id is required")
        if not VIEW_ID_PATTERN.fullmatch(view_id):
            raise ReferenceSetError(
                f"referenceSet view id {view_id!r} must match {VIEW_ID_PATTERN.pattern}"
            )
        canonical_view_id = view_id.casefold()
        if canonical_view_id in seen_ids:
            raise ReferenceSetError(f"duplicate referenceSet view id: {view_id}")
        seen_ids.add(canonical_view_id)

        path_value, local_path = _resolve_path(raw_view.get("path"), base_dir)
        canonical_path = path_value.casefold() if local_path is not None else path_value
        if canonical_path in seen_paths:
            raise ReferenceSetError(f"duplicate referenceSet view path: {path_value}")
        seen_paths.add(canonical_path)
        if require_files and local_path is not None and not local_path.is_file():
            raise ReferenceSetError(f"referenceSet view image does not exist: {local_path}")

        sha256 = _content_hash(local_path)
        declared_hash = raw_view.get("sha256")
        normalized_declared_hash = ""
        if declared_hash is not None:
            if not isinstance(declared_hash, str) or not SHA256_PATTERN.fullmatch(declared_hash):
                raise ReferenceSetError(
                    f"referenceSet view {view_id!r} sha256 must be exactly 64 hexadecimal characters"
                )
            normalized_declared_hash = declared_hash.lower()
        if normalized_declared_hash and sha256 and normalized_declared_hash != sha256:
            raise ReferenceSetError(f"referenceSet view {view_id!r} sha256 does not match its file")
        sha256 = sha256 or normalized_declared_hash
        if sha256:
            if sha256 in seen_hashes:
                raise ReferenceSetError(f"duplicate referenceSet view sha256: {sha256}")
            seen_hashes.add(sha256)

        if mode == "camera-aware" and not _valid_solved_camera(raw_view.get("camera")):
            raise ReferenceSetError(
                f"camera-aware referenceSet view {view_id!r} requires a complete solved camera"
            )

        view = deepcopy(raw_view)
        view.update(
            {
                "id": view_id,
                "role": str(raw_view.get("role") or view_id),
                "path": path_value,
            }
        )
        if sha256:
            view["sha256"] = sha256
        normalized_views.append(view)

    primary = str(primary_view_id or normalized_views[0]["id"])
    primary_match = next(
        (view["id"] for view in normalized_views if view["id"].casefold() == primary.casefold()),
        None,
    )
    if primary_match is None:
        raise ReferenceSetError(f"referenceSet primaryViewId {primary!r} does not name a view")
    primary = primary_match

    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "img2threejs.reference-set",
        "mode": mode,
        "primaryViewId": primary,
        "views": normalized_views,
    }


def primary_view(reference_set: dict[str, Any]) -> dict[str, Any]:
    primary_id = reference_set.get("primaryViewId")
    for view in reference_set.get("views", []):
        if isinstance(view, dict) and view.get("id") == primary_id:
            return view
    raise ReferenceSetError("referenceSet primary view is missing")


def write_reference_set(path: Path, reference_set: dict[str, Any]) -> Path:
    target = path.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(reference_set, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target
