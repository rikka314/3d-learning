from __future__ import annotations

import importlib
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from forge.stage3_build.orchestrate_passes import review_completes_pass as orchestrator_credits_review
from forge.stage2_spec.validate_sculpt_spec import review_completes_pass as validator_credits_review
from forge.stage2_spec.validate_sculpt_spec import validate_review_history

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "stage4_review"))

import make_comparison_sheet  # noqa: E402
from append_review import main as append_review_main  # noqa: E402


class MultiViewReviewTest(unittest.TestCase):
    def _write_image(self, path: Path, color: tuple[int, int, int]) -> None:
        make_comparison_sheet.write_png_rgb(path, 2, 2, [color] * 4)

    def _images(self, root: Path) -> dict[str, Path]:
        paths = {
            "front_reference": root / "front-reference.png",
            "front_render": root / "front-render.png",
            "side_reference": root / "side-reference.png",
            "side_render": root / "side-render.png",
        }
        for index, path in enumerate(paths.values(), start=1):
            self._write_image(path, (index * 30, index * 20, index * 10))
        return paths

    def _run_bundle(
        self,
        references: list[str],
        renders: list[str],
        out_dir: Path,
        manifest: Path,
        *,
        primary_view: str | None = None,
    ) -> int:
        module = importlib.import_module("make_multiview_comparison")
        argv = [
            "--reference",
            *references,
            "--render",
            *renders,
            "--out-dir",
            str(out_dir),
            "--out",
            str(manifest),
            "--panel-width",
            "128",
            "--panel-height",
            "128",
            "--gutter",
            "6",
        ]
        if primary_view:
            argv.extend(["--primary-view", primary_view])
        return module.main(argv)

    def _spec(self, source_image: Path) -> dict:
        return {
            "sourceImage": str(source_image),
            "referenceSet": {
                "primaryViewId": "front",
                "views": [
                    {"id": "front", "path": str(source_image)},
                    {"id": "side", "path": str(source_image.with_name("side-reference.png"))},
                ],
            },
            "selfCorrectLoop": {"visualAcceptance": {"threshold": 0.7}},
        }

    def _view_reviews(self, images: dict[str, Path], *, front_score: float = 0.9) -> list[dict]:
        return [
            {
                "viewId": "front",
                "critical": True,
                "referenceScreenshot": str(images["front_reference"]),
                "renderScreenshot": str(images["front_render"]),
                "comparisonImage": "front-comparison.png",
                "aiVisionScore": front_score,
                "notes": "front matched",
            },
            {
                "viewId": "side",
                "critical": True,
                "referenceScreenshot": str(images["side_reference"]),
                "renderScreenshot": str(images["side_render"]),
                "comparisonImage": "side-comparison.png",
                "aiVisionScore": 0.88,
                "notes": "side matched",
            },
        ]

    def test_creates_one_matched_review_entry_per_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)

            manifest = root / "matched-review.json"
            with redirect_stdout(StringIO()):
                result = self._run_bundle(
                    [
                        f"front={images['front_reference']}",
                        f"side={images['side_reference']}",
                    ],
                    [
                        f"front={images['front_render']}",
                        f"side={images['side_render']}",
                    ],
                    root / "comparisons",
                    manifest,
                )
            payload = json.loads(manifest.read_text(encoding="utf-8"))

            self.assertEqual(result, 0)
            self.assertEqual([view["viewId"] for view in payload["viewReviews"]], ["front", "side"])
            self.assertTrue(all(Path(view["comparisonImage"]).is_file() for view in payload["viewReviews"]))

    def test_rejects_reference_view_without_matching_render(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)

            stderr = StringIO()
            with redirect_stderr(stderr):
                result = self._run_bundle(
                    [
                        f"front={images['front_reference']}",
                        f"side={images['side_reference']}",
                    ],
                    [f"front={images['front_render']}"],
                    root / "comparisons",
                    root / "matched-review.json",
                )
            self.assertEqual(result, 1)
            self.assertRegex(stderr.getvalue(), "missing.*render.*side")

    def test_rejects_duplicate_view_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)

            stderr = StringIO()
            with redirect_stderr(stderr):
                result = self._run_bundle(
                    [
                        f"front={images['front_reference']}",
                        f"front={images['side_reference']}",
                    ],
                    [f"front={images['front_render']}"],
                    root / "comparisons",
                    root / "matched-review.json",
                )
            self.assertEqual(result, 1)
            self.assertRegex(stderr.getvalue(), "duplicate.*front")

    def test_primary_view_populates_legacy_bundle_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)

            manifest = root / "matched-review.json"
            with redirect_stdout(StringIO()):
                result = self._run_bundle(
                    [
                        f"front={images['front_reference']}",
                        f"side={images['side_reference']}",
                    ],
                    [
                        f"front={images['front_render']}",
                        f"side={images['side_render']}",
                    ],
                    root / "comparisons",
                    manifest,
                    primary_view="side",
                )
            payload = json.loads(manifest.read_text(encoding="utf-8"))

            side = next(view for view in payload["viewReviews"] if view["viewId"] == "side")
            self.assertEqual(result, 0)
            self.assertEqual(payload["primaryViewId"], "side")
            self.assertEqual(payload["referenceImage"], side["referenceScreenshot"])
            self.assertEqual(payload["renderScreenshot"], side["renderScreenshot"])
            self.assertEqual(payload["comparisonImage"], side["comparisonImage"])

    def test_append_review_records_view_reviews(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            reviews = self._view_reviews(images)

            with redirect_stdout(StringIO()):
                result = append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "all source views matched",
                        "--view-reviews-json",
                        json.dumps(reviews),
                        "--force-out-of-order",
                        "--in-place",
                    ]
                )

            persisted = json.loads(spec_path.read_text(encoding="utf-8"))
            self.assertEqual(result, 0)
            self.assertEqual(persisted["reviewHistory"][0]["viewReviews"], reviews)

    def test_append_review_accepts_comparison_bundle_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            bundle_path = root / "matched-review.json"
            with redirect_stdout(StringIO()):
                self._run_bundle(
                    [
                        f"front={images['front_reference']}",
                        f"side={images['side_reference']}",
                    ],
                    [
                        f"front={images['front_render']}",
                        f"side={images['side_render']}",
                    ],
                    root / "comparisons",
                    bundle_path,
                )
            bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
            for review in bundle["viewReviews"]:
                review.update({"critical": True, "aiVisionScore": 0.9, "notes": "matched"})
            bundle_path.write_text(json.dumps(bundle), encoding="utf-8")

            with redirect_stdout(StringIO()):
                result = append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "comparison bundle accepted",
                        "--view-reviews-json",
                        str(bundle_path),
                        "--force-out-of-order",
                        "--in-place",
                    ]
                )

            persisted = json.loads(spec_path.read_text(encoding="utf-8"))
            self.assertEqual(result, 0)
            self.assertEqual(
                [review["viewId"] for review in persisted["reviewHistory"][0]["viewReviews"]],
                ["front", "side"],
            )
            self.assertTrue(
                orchestrator_credits_review(
                    persisted,
                    persisted["reviewHistory"][0],
                    "structural-pass",
                )
            )
            self.assertTrue(
                validator_credits_review(
                    persisted,
                    persisted["reviewHistory"][0],
                    "structural-pass",
                )
            )
            errors: list[str] = []
            warnings: list[str] = []
            validate_review_history(persisted, errors, warnings)
            self.assertEqual(errors, [])
            self.assertFalse(
                any("without a render screenshot" in warning for warning in warnings),
                warnings,
            )
            self.assertFalse(
                any("without an AI vision comparison image" in warning for warning in warnings),
                warnings,
            )

    def test_persisted_invalid_threshold_never_completes_a_multiview_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            for invalid_threshold in (-1.0, float("nan"), float("inf")):
                with self.subTest(threshold=invalid_threshold):
                    spec = self._spec(images["front_reference"])
                    reviews = self._view_reviews(images, front_score=0.0)
                    reviews[1]["aiVisionScore"] = 0.0
                    entry = {
                        "passId": "structural-pass",
                        "action": "continue",
                        "aiVisionScore": 0.0,
                        "visualAcceptanceThreshold": invalid_threshold,
                        "viewReviews": reviews,
                    }
                    spec["reviewHistory"] = [entry]

                    self.assertFalse(orchestrator_credits_review(spec, entry, "structural-pass"))
                    self.assertFalse(validator_credits_review(spec, entry, "structural-pass"))
                    errors: list[str] = []
                    warnings: list[str] = []
                    validate_review_history(spec, errors, warnings)
                    self.assertTrue(
                        any("visualAcceptanceThreshold" in error for error in errors),
                        errors,
                    )

    def test_critical_view_below_threshold_blocks_continue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            reviews = self._view_reviews(images, front_score=0.42)

            with self.assertRaisesRegex(ValueError, "critical.*front.*below threshold"):
                append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "front view failed",
                        "--view-reviews-json",
                        json.dumps(reviews),
                        "--force-out-of-order",
                    ]
                )

    def test_all_views_are_gating_when_no_view_is_marked_critical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            reviews = self._view_reviews(images)
            for review in reviews:
                review.pop("critical", None)
            reviews[1]["aiVisionScore"] = 0.42

            with self.assertRaisesRegex(ValueError, "view.*side.*below threshold"):
                append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "side view failed",
                        "--view-reviews-json",
                        json.dumps(reviews),
                        "--force-out-of-order",
                    ]
                )

    def test_continue_rejects_missing_reference_set_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            reviews = self._view_reviews(images)[:1]

            with self.assertRaisesRegex(ValueError, "missing.*side"):
                append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "side view omitted",
                        "--view-reviews-json",
                        json.dumps(reviews),
                        "--force-out-of-order",
                    ]
                )

    def test_continue_rejects_reference_bound_to_wrong_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            reviews = self._view_reviews(images)
            reviews[1]["referenceScreenshot"] = str(images["front_reference"])

            with self.assertRaisesRegex(ValueError, "side.*reference.*match"):
                append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "wrong source bound to side",
                        "--view-reviews-json",
                        json.dumps(reviews),
                        "--force-out-of-order",
                    ]
                )

    def test_boolean_view_score_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")
            reviews = self._view_reviews(images)
            reviews[0]["aiVisionScore"] = True

            with self.assertRaisesRegex(ValueError, "aiVisionScore.*0 to 1"):
                append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "boolean score is invalid",
                        "--view-reviews-json",
                        json.dumps(reviews),
                        "--force-out-of-order",
                    ]
                )

    def test_legacy_single_pair_sheet_remains_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            out = root / "legacy-comparison.png"

            payload = make_comparison_sheet.create_sheet(
                images["front_reference"],
                images["front_render"],
                out,
                128,
                128,
                6,
            )

            self.assertTrue(out.is_file())
            self.assertEqual(payload["referenceImage"], str(images["front_reference"].resolve()))
            self.assertEqual(payload["renderScreenshot"], str(images["front_render"].resolve()))

    def test_legacy_single_view_review_remains_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = self._images(root)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(self._spec(images["front_reference"])), encoding="utf-8")

            with redirect_stdout(StringIO()):
                result = append_review_main(
                    [
                        str(spec_path),
                        "--pass-id",
                        "structural-pass",
                        "--fidelity",
                        "0.9",
                        "--action",
                        "continue",
                        "--summary",
                        "legacy pair matched",
                        "--reference-screenshot",
                        str(images["front_reference"]),
                        "--render-screenshot",
                        str(images["front_render"]),
                        "--comparison-image",
                        "legacy-comparison.png",
                        "--ai-vision-score",
                        "0.9",
                        "--force-out-of-order",
                        "--in-place",
                    ]
                )

            persisted = json.loads(spec_path.read_text(encoding="utf-8"))
            self.assertEqual(result, 0)
            self.assertEqual(
                persisted["reviewHistory"][0]["visualEvidence"]["cameraView"],
                "",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
