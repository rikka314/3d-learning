from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any


def is_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _is_remote_path(value: str) -> bool:
    return "://" in value or value.startswith(("data:", "blob:"))


def _same_source(left: str, right: str) -> bool:
    if _is_remote_path(left) or _is_remote_path(right):
        return left == right
    return str(Path(left).expanduser().resolve()).casefold() == str(
        Path(right).expanduser().resolve()
    ).casefold()


def _sha256(path: str) -> str:
    if _is_remote_path(path):
        return ""
    candidate = Path(path).expanduser()
    if not candidate.is_file():
        return ""
    digest = hashlib.sha256()
    with candidate.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def multiview_evidence_failures(
    spec: dict[str, Any],
    reviews: object,
    threshold: object,
) -> list[str]:
    failures: list[str] = []
    if not is_number(threshold) or not 0.0 <= float(threshold) <= 1.0:
        return ["visual acceptance threshold must be a finite number from 0 to 1"]
    numeric_threshold = float(threshold)
    if not isinstance(reviews, list) or not reviews:
        return ["viewReviews must be a non-empty array"]

    reference_set = spec.get("referenceSet")
    reference_views = reference_set.get("views") if isinstance(reference_set, dict) else None
    expected: dict[str, dict[str, Any]] = {}
    if isinstance(reference_views, list):
        expected = {
            view["id"]: view
            for view in reference_views
            if isinstance(view, dict)
            and isinstance(view.get("id"), str)
            and view["id"].strip()
        }

    seen: set[str] = set()
    has_explicit_critical = any(
        isinstance(review, dict) and review.get("critical") is True
        for review in reviews
    )
    for index, review in enumerate(reviews):
        if not isinstance(review, dict):
            failures.append(f"viewReviews[{index}] must be an object")
            continue
        view_id = review.get("viewId")
        if not isinstance(view_id, str) or not view_id.strip():
            failures.append(f"viewReviews[{index}].viewId is required")
            continue
        if view_id in seen:
            failures.append(f"duplicate view review id: {view_id}")
            continue
        seen.add(view_id)
        critical = review.get("critical")
        if critical is not None and not isinstance(critical, bool):
            failures.append(f"view {view_id} critical must be boolean")
        for field in ("referenceScreenshot", "renderScreenshot", "comparisonImage"):
            if not isinstance(review.get(field), str) or not review[field].strip():
                failures.append(f"view {view_id} {field} is required")
        score = review.get("aiVisionScore")
        if not is_number(score) or not 0.0 <= float(score) <= 1.0:
            failures.append(f"view {view_id} aiVisionScore must be a finite number from 0 to 1")
        elif (review.get("critical") is True or not has_explicit_critical) and float(score) < numeric_threshold:
            failures.append(
                f"view {view_id} score {float(score):.3f} is below threshold {numeric_threshold:.3f}"
            )

        source = expected.get(view_id)
        reference_screenshot = review.get("referenceScreenshot")
        if source is not None and isinstance(reference_screenshot, str):
            source_path = source.get("path")
            if isinstance(source_path, str) and not _same_source(source_path, reference_screenshot):
                failures.append(
                    f"view {view_id} referenceScreenshot does not match referenceSet path"
                )
            declared_hash = source.get("sha256")
            if isinstance(declared_hash, str) and declared_hash:
                actual_hash = _sha256(reference_screenshot)
                if actual_hash and actual_hash != declared_hash:
                    failures.append(
                        f"view {view_id} referenceScreenshot sha256 does not match referenceSet"
                    )

    if expected:
        missing = sorted(set(expected) - seen)
        unknown = sorted(seen - set(expected))
        if missing:
            failures.append("view reviews are missing referenceSet view(s): " + ", ".join(missing))
        if unknown:
            failures.append("view reviews contain unknown referenceSet view(s): " + ", ".join(unknown))
    return failures
