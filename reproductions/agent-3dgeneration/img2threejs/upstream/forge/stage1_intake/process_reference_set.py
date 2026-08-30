#!/usr/bin/env python3
"""Run deterministic technical/admission intake for every view in a ReferenceSet."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_shared"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from reference_set import ReferenceSetError, normalize_reference_set  # noqa: E402
from check_reference_admission import check_admission  # noqa: E402
from probe_image import probe  # noqa: E402


def process_reference_set(manifest: Path) -> dict[str, Any]:
    reference_set = normalize_reference_set(manifest=manifest, require_files=True)
    admitted_hashes: list[int] = []
    views: list[dict[str, Any]] = []
    admitted_ids: list[str] = []
    rejected_ids: list[str] = []

    for view in reference_set["views"]:
        path = Path(view["path"])
        technical = probe(path)
        admission = check_admission(path, str(view.get("role") or view["id"]), admitted_hashes)
        phash = admission.get("provenance", {}).get("pHash")
        if admission.get("admitted"):
            admitted_ids.append(view["id"])
            if isinstance(phash, int):
                admitted_hashes.append(phash)
        else:
            rejected_ids.append(view["id"])
        views.append(
            {
                "viewId": view["id"],
                "role": view.get("role", view["id"]),
                "sourceImage": view["path"],
                "sha256": view.get("sha256", ""),
                "camera": view.get("camera"),
                "evidence": view.get("evidence", {}),
                "technicalProbe": technical,
                "admission": admission,
            }
        )

    return {
        "schemaVersion": 1,
        "kind": "img2threejs.reference-set-intake",
        "primaryViewId": reference_set["primaryViewId"],
        "referenceSet": reference_set,
        "views": views,
        "summary": {
            "viewCount": len(views),
            "admittedViewIds": admitted_ids,
            "rejectedViewIds": rejected_ids,
            "status": "proceed" if not rejected_ids else "request-input",
        },
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference_set", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        payload = process_reference_set(args.reference_set.expanduser().resolve())
        output = args.out.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(output)
        return 0 if payload["summary"]["status"] == "proceed" else 3
    except (OSError, ReferenceSetError, ValueError) as error:
        print(f"reference-set intake error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
