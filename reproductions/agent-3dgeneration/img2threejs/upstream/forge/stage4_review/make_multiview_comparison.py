#!/usr/bin/env python3
"""Create matched reference/render comparison sheets for multiple named views."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "_shared"))
from make_comparison_sheet import create_sheet
from reference_set import VIEW_ID_PATTERN



def parse_views(values: list[str], label: str) -> tuple[list[str], dict[str, Path]]:
    order: list[str] = []
    views: dict[str, Path] = {}
    canonical_ids: set[str] = set()
    for value in values:
        view_id, separator, raw_path = value.partition("=")
        view_id = view_id.strip()
        raw_path = raw_path.strip()
        if not separator or not view_id or not raw_path:
            raise ValueError(f"{label} entries must use viewId=path")
        if not VIEW_ID_PATTERN.fullmatch(view_id):
            raise ValueError(f"invalid {label} view id: {view_id!r}")
        canonical_id = view_id.casefold()
        if canonical_id in canonical_ids:
            raise ValueError(f"duplicate {label} view id: {view_id}")
        canonical_ids.add(canonical_id)
        order.append(view_id)
        views[view_id] = Path(raw_path).expanduser().resolve()
    return order, views


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", nargs="+", required=True, metavar="VIEW=PATH")
    parser.add_argument("--render", nargs="+", required=True, metavar="VIEW=PATH")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="Output review manifest JSON")
    parser.add_argument("--primary-view", help="View used for legacy single-pair manifest fields")
    parser.add_argument("--panel-width", type=int, default=720)
    parser.add_argument("--panel-height", type=int, default=720)
    parser.add_argument("--gutter", type=int, default=24)
    try:
        args = parser.parse_args(argv)
        reference_order, references = parse_views(args.reference, "reference")
        _, renders = parse_views(args.render, "render")
        missing_renders = [view_id for view_id in reference_order if view_id not in renders]
        if missing_renders:
            raise ValueError("missing render for reference view(s): " + ", ".join(missing_renders))
        extra_renders = [view_id for view_id in renders if view_id not in references]
        if extra_renders:
            raise ValueError("render view(s) have no matching reference: " + ", ".join(extra_renders))

        primary_view = args.primary_view or reference_order[0]
        if primary_view not in references:
            raise ValueError(f"primary view has no matched reference/render pair: {primary_view}")

        out_dir = args.out_dir.expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        view_reviews: list[dict] = []
        for view_id in reference_order:
            comparison = out_dir / f"{view_id}-comparison.png"
            sheet = create_sheet(
                references[view_id],
                renders[view_id],
                comparison,
                max(128, args.panel_width),
                max(128, args.panel_height),
                max(6, args.gutter),
            )
            view_reviews.append(
                {
                    "viewId": view_id,
                    "referenceScreenshot": sheet["referenceImage"],
                    "renderScreenshot": sheet["renderScreenshot"],
                    "comparisonImage": sheet["comparisonImage"],
                }
            )

        primary = next(view for view in view_reviews if view["viewId"] == primary_view)
        payload = {
            "primaryViewId": primary_view,
            "viewReviews": view_reviews,
            "referenceImage": primary["referenceScreenshot"],
            "renderScreenshot": primary["renderScreenshot"],
            "comparisonImage": primary["comparisonImage"],
            "layout": "one matched reference/render sheet per view",
            "note": "Send each comparison image to AI vision and add scores before appending the review.",
        }
        output = args.out.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(output)
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
