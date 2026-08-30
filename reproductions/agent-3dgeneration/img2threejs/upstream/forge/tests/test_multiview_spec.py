from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from forge.stage2_spec.new_pre_spec_assessment import make_payload
from forge.stage2_spec.new_sculpt_spec import make_spec
from forge.stage2_spec.validate_sculpt_spec import validate_spec


FORGE_ROOT = Path(__file__).resolve().parents[1]


def camera(*, yaw: float) -> dict:
    return {
        "solved": True,
        "fovDegrees": 42.0,
        "aspect": 1.5,
        "orientation": {"yaw": yaw, "pitch": 0.0, "roll": 0.0},
        "positionHint": [0.0, 0.0, 3.0],
    }


def reference_set() -> dict:
    return {
        "schemaVersion": 1,
        "mode": "camera-aware",
        "primaryViewId": "front",
        "views": [
            {
                "id": "front",
                "role": "front",
                "path": "references/front.png",
                "camera": camera(yaw=0.0),
                "evidence": {
                    "mask": "evidence/front-mask.png",
                    "depth": "evidence/front-depth.exr",
                },
            },
            {
                "id": "right",
                "role": "right",
                "path": "references/right.png",
                "camera": camera(yaw=90.0),
                "evidence": {
                    "mask": "evidence/right-mask.png",
                    "landmarks": "evidence/right-landmarks.json",
                },
            },
        ],
    }


def multiview_assessment() -> dict:
    return make_payload(
        "Widget",
        None,
        "moderate",
        reference_set=reference_set(),
    )


def assert_error_mentions(test: unittest.TestCase, errors: list[str], *terms: str) -> None:
    normalized = "\n".join(errors).lower()
    test.assertTrue(errors, "expected validation to fail")
    test.assertTrue(
        all(term.lower() in normalized for term in terms),
        f"expected an error mentioning {terms!r}, got: {errors!r}",
    )


class MultiViewAssessmentTests(unittest.TestCase):
    def test_assessment_cli_accepts_reference_set_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "references.json"
            output = root / "assessment.json"
            manifest.write_text(json.dumps(reference_set()), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(FORGE_ROOT / "stage2_spec" / "new_pre_spec_assessment.py"),
                    "Widget",
                    "--reference-set",
                    str(manifest),
                    "--out",
                    str(output),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                Path(payload["referenceSet"]["views"][0]["path"]),
                (root / "references" / "front.png").resolve(),
            )

    def test_assessment_includes_reference_set(self) -> None:
        references = reference_set()

        payload = make_payload(
            "Widget",
            None,
            "moderate",
            reference_set=references,
        )

        self.assertEqual(payload["referenceSet"], references)

    def test_assessment_mirrors_primary_view_to_legacy_source_image(self) -> None:
        payload = multiview_assessment()

        self.assertEqual(payload["sourceImage"], "references/front.png")

    def test_assessment_preserves_camera_and_evidence_for_each_view(self) -> None:
        payload = multiview_assessment()

        views = {view["id"]: view for view in payload["referenceSet"]["views"]}
        self.assertEqual(views["front"]["camera"], camera(yaw=0.0))
        self.assertEqual(
            views["right"]["evidence"]["landmarks"],
            "evidence/right-landmarks.json",
        )


class MultiViewSpecTests(unittest.TestCase):
    def test_spec_cli_accepts_reference_set_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "references.json"
            output = root / "spec.json"
            manifest.write_text(json.dumps(reference_set()), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(FORGE_ROOT / "stage2_spec" / "new_sculpt_spec.py"),
                    "Widget",
                    "--reference-set",
                    str(manifest),
                    "--out",
                    str(output),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                Path(payload["referenceSet"]["views"][0]["path"]),
                (root / "references" / "front.png").resolve(),
            )
            self.assertEqual(payload["sourceImage"], payload["referenceSet"]["views"][0]["path"])

    def test_spec_includes_reference_set_from_assessment(self) -> None:
        assessment = multiview_assessment()

        spec = make_spec("Widget", None, assessment)

        self.assertEqual(spec["referenceSet"], assessment["referenceSet"])

    def test_spec_mirrors_primary_view_to_legacy_fields(self) -> None:
        assessment = multiview_assessment()

        spec = make_spec("Widget", None, assessment)

        self.assertEqual(spec["sourceImage"], "references/front.png")
        self.assertEqual(spec["referenceCamera"], camera(yaw=0.0))


class MultiViewSpecValidationTests(unittest.TestCase):
    def valid_spec(self) -> dict:
        references = reference_set()
        spec = make_spec("Widget", "references/front.png")
        spec["referenceSet"] = references
        spec["referenceCamera"] = references["views"][0]["camera"]
        return spec

    def test_validator_accepts_valid_multiview_spec(self) -> None:
        errors, _warnings = validate_spec(self.valid_spec())

        self.assertEqual(errors, [])

    def test_validator_rejects_reference_set_without_primary_view(self) -> None:
        spec = self.valid_spec()
        spec["referenceSet"]["primaryViewId"] = "rear"

        errors, _warnings = validate_spec(spec)

        assert_error_mentions(self, errors, "referenceset", "primary")

    def test_validator_rejects_duplicate_view_ids(self) -> None:
        spec = self.valid_spec()
        spec["referenceSet"]["views"][1]["id"] = "front"

        errors, _warnings = validate_spec(spec)

        assert_error_mentions(self, errors, "referenceset", "duplicate")

    def test_validator_rejects_invalid_camera_aware_metadata(self) -> None:
        spec = self.valid_spec()
        spec["referenceSet"]["views"][1]["camera"]["fovDegrees"] = 0.0

        errors, _warnings = validate_spec(spec)

        assert_error_mentions(self, errors, "referenceset", "camera")

    def test_validator_rejects_unsolved_camera_aware_view(self) -> None:
        spec = self.valid_spec()
        spec["referenceSet"]["views"][1]["camera"]["solved"] = False

        errors, _warnings = validate_spec(spec)

        assert_error_mentions(self, errors, "referenceset", "camera")

    def test_validator_still_accepts_legacy_single_image_spec(self) -> None:
        spec = make_spec("Widget", "references/front.png")

        errors, _warnings = validate_spec(spec)

        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
