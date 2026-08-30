from __future__ import annotations

import hashlib
import importlib
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "forge" / "_shared"))

from workflow_state import new_state, validate_state  # noqa: E402


def reference_set_module():
    """Import lazily so missing production code is reported as RED per test."""
    return importlib.import_module("reference_set")


def write_reference(path: Path, payload: bytes) -> None:
    """Write a tiny valid RGB PNG whose pixels are deterministic for ``payload``."""
    digest = hashlib.sha256(payload).digest()
    width = height = 16
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            offset = (x * 5 + y * 11) % len(digest)
            row.extend((digest[offset], digest[(offset + 1) % len(digest)], digest[(offset + 2) % len(digest)]))
        rows.append(b"\x00" + bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


class ReferenceSetNormalizationTest(unittest.TestCase):
    def test_legacy_single_image_normalizes_to_one_primary_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "object.png"
            write_reference(reference, b"legacy-reference")

            normalized = reference_set_module().normalize_reference_set(
                references=[reference], require_files=True
            )

            self.assertEqual(normalized["schemaVersion"], 1)
            self.assertEqual(normalized["primaryViewId"], "primary")
            self.assertEqual(len(normalized["views"]), 1)
            self.assertEqual(normalized["views"][0]["id"], "primary")
            self.assertEqual(Path(normalized["views"][0]["path"]), reference.resolve())

    def test_manifest_normalizes_multiple_views_and_resolves_relative_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            right = root / "right.png"
            write_reference(front, b"front-reference")
            write_reference(right, b"right-reference")
            manifest = root / "reference-set.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "mode": "vision-context",
                        "primaryViewId": "front",
                        "views": [
                            {"id": "front", "role": "front", "path": "front.png"},
                            {"id": "right", "role": "right", "path": "right.png"},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            normalized = reference_set_module().normalize_reference_set(
                manifest=manifest, require_files=True
            )

            self.assertEqual([view["id"] for view in normalized["views"]], ["front", "right"])
            self.assertEqual(Path(normalized["views"][0]["path"]), front.resolve())
            self.assertEqual(Path(normalized["views"][1]["path"]), right.resolve())
            self.assertEqual(
                normalized["views"][0]["sha256"], hashlib.sha256(front.read_bytes()).hexdigest()
            )

    def test_manifest_preserves_explicit_primary_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            rear = root / "rear.png"
            write_reference(front, b"front-reference")
            write_reference(rear, b"rear-reference")

            normalized = reference_set_module().normalize_reference_set(
                manifest={
                    "schemaVersion": 1,
                    "primaryViewId": "rear",
                    "views": [
                        {"id": "front", "path": str(front)},
                        {"id": "rear", "path": str(rear)},
                    ],
                },
                require_files=True,
            )

            self.assertEqual(normalized["primaryViewId"], "rear")

    def test_primary_view_id_uses_the_declared_view_spelling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "front.png"
            write_reference(reference, b"primary-case")

            normalized = reference_set_module().normalize_reference_set(
                manifest={
                    "schemaVersion": 1,
                    "primaryViewId": "front",
                    "views": [{"id": "Front", "path": str(reference)}],
                },
                require_files=True,
            )

            self.assertEqual(normalized["primaryViewId"], "Front")
            self.assertEqual(reference_set_module().primary_view(normalized)["id"], "Front")

    def test_camera_aware_mode_requires_a_complete_solved_camera_per_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "front.png"
            write_reference(reference, b"camera-aware")
            module = reference_set_module()

            invalid_cameras = (
                None,
                {"solved": False},
                {"solved": True},
            )
            for camera in invalid_cameras:
                with self.subTest(camera=camera):
                    view = {"id": "front", "path": str(reference)}
                    if camera is not None:
                        view["camera"] = camera
                    with self.assertRaisesRegex(module.ReferenceSetError, "camera"):
                        module.normalize_reference_set(
                            manifest={
                                "schemaVersion": 1,
                                "mode": "camera-aware",
                                "views": [view],
                            },
                            require_files=True,
                        )

    def test_duplicate_view_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            write_reference(first, b"first-reference")
            write_reference(second, b"second-reference")
            module = reference_set_module()

            with self.assertRaisesRegex(module.ReferenceSetError, "duplicate.*id"):
                module.normalize_reference_set(
                    manifest={
                        "schemaVersion": 1,
                        "views": [
                            {"id": "front", "path": str(first)},
                            {"id": "front", "path": str(second)},
                        ],
                    },
                    require_files=True,
                )

    def test_view_id_must_be_safe_for_review_artifact_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "object.png"
            write_reference(reference, b"unsafe-id")
            module = reference_set_module()

            with self.assertRaisesRegex(module.ReferenceSetError, "view id"):
                module.normalize_reference_set(
                    manifest={
                        "schemaVersion": 1,
                        "views": [{"id": "front view", "path": str(reference)}],
                    },
                    require_files=True,
                )

    def test_view_ids_are_case_insensitively_unique_for_windows_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            write_reference(first, b"first-case-id")
            write_reference(second, b"second-case-id")
            module = reference_set_module()

            with self.assertRaisesRegex(module.ReferenceSetError, "duplicate.*id"):
                module.normalize_reference_set(
                    manifest={
                        "schemaVersion": 1,
                        "views": [
                            {"id": "front", "path": str(first)},
                            {"id": "Front", "path": str(second)},
                        ],
                    },
                    require_files=True,
                )

    def test_same_canonical_path_is_rejected_as_a_duplicate_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "object.png"
            write_reference(reference, b"same-reference")
            module = reference_set_module()

            with self.assertRaisesRegex(module.ReferenceSetError, "duplicate.*path"):
                module.normalize_reference_set(
                    manifest={
                        "schemaVersion": 1,
                        "views": [
                            {"id": "front", "path": str(reference)},
                            {"id": "detail", "path": str(root / "." / "object.png")},
                        ],
                    },
                    require_files=True,
                )

    def test_same_content_hash_is_rejected_as_a_near_duplicate_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            duplicate = root / "duplicate.png"
            write_reference(front, b"same-image-content")
            write_reference(duplicate, b"same-image-content")
            module = reference_set_module()

            with self.assertRaisesRegex(module.ReferenceSetError, "duplicate.*sha256|sha256.*duplicate"):
                module.normalize_reference_set(
                    manifest={
                        "schemaVersion": 1,
                        "views": [
                            {"id": "front", "path": str(front)},
                            {"id": "right", "path": str(duplicate)},
                        ],
                    },
                    require_files=True,
                )

    def test_declared_sha256_is_validated_and_normalized_to_lowercase(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "object.png"
            write_reference(reference, b"uppercase-sha")
            expected = hashlib.sha256(reference.read_bytes()).hexdigest()

            normalized = reference_set_module().normalize_reference_set(
                manifest={
                    "schemaVersion": 1,
                    "views": [
                        {
                            "id": "front",
                            "path": str(reference),
                            "sha256": expected.upper(),
                        }
                    ],
                },
                require_files=True,
            )

            self.assertEqual(normalized["views"][0]["sha256"], expected)

    def test_remote_view_rejects_malformed_declared_sha256(self) -> None:
        module = reference_set_module()

        with self.assertRaisesRegex(module.ReferenceSetError, "sha256"):
            module.normalize_reference_set(
                manifest={
                    "schemaVersion": 1,
                    "views": [
                        {
                            "id": "front",
                            "path": "https://example.invalid/front.png",
                            "sha256": "not-a-sha",
                        }
                    ],
                }
            )

    def test_missing_view_image_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.png"
            module = reference_set_module()

            with self.assertRaisesRegex(module.ReferenceSetError, "does not exist|missing"):
                module.normalize_reference_set(references=[missing], require_files=True)


class ReferenceSetWorkflowStateTest(unittest.TestCase):
    def test_schema_v1_state_with_only_legacy_reference_remains_valid(self) -> None:
        state = new_state("reference.png")
        state["artifacts"].pop("referenceSet", None)

        validated = validate_state(state)

        self.assertEqual(validated["schemaVersion"], 1)
        self.assertEqual(validated["artifacts"]["reference"], "reference.png")

    def test_repeatable_reference_cli_records_primary_and_reference_set_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            right = root / "right.png"
            state_path = root / "state.json"
            write_reference(front, b"front-reference")
            write_reference(right, b"right-reference")

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "state.py"),
                    "init",
                    "--state",
                    str(state_path),
                    "--reference",
                    f"front={front}",
                    "--reference",
                    f"right={right}",
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(Path(state["artifacts"]["reference"]), front.resolve())
            self.assertEqual(state["artifacts"]["referenceSet"]["primaryViewId"], "front")
            self.assertEqual(
                [view["id"] for view in state["artifacts"]["referenceSet"]["views"]],
                ["front", "right"],
            )

    def test_reference_set_manifest_cli_records_normalized_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            right = root / "right.png"
            state_path = root / "state.json"
            manifest_path = root / "reference-set.json"
            write_reference(front, b"front-reference")
            write_reference(right, b"right-reference")
            manifest_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "primaryViewId": "right",
                        "views": [
                            {"id": "front", "path": "front.png"},
                            {"id": "right", "path": "right.png"},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "state.py"),
                    "init",
                    "--state",
                    str(state_path),
                    "--reference-set",
                    str(manifest_path),
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(Path(state["artifacts"]["reference"]), right.resolve())
            self.assertEqual(state["artifacts"]["referenceSet"]["primaryViewId"], "right")

    def test_state_init_does_not_overwrite_the_user_reference_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            state_path = root / "state.json"
            manifest_path = root / "references.json"
            write_reference(front, b"front-reference")
            original = {
                "schemaVersion": 1,
                "views": [{"id": "front", "path": "front.png"}],
            }
            manifest_path.write_text(json.dumps(original), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "state.py"),
                    "init",
                    "--state",
                    str(state_path),
                    "--reference-set",
                    str(manifest_path),
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(manifest_path.read_text(encoding="utf-8")), original)
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertNotEqual(Path(state["artifacts"]["referenceSetManifest"]), manifest_path)

    def test_state_init_does_not_overwrite_existing_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            state_path = root / "state.json"
            sidecar_path = root / "state.references.json"
            write_reference(front, b"front-reference")
            sidecar_path.write_text('{"owner":"user"}\n', encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "state.py"),
                    "init",
                    "--state",
                    str(state_path),
                    "--reference",
                    str(front),
                ],
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sidecar_path.read_text(encoding="utf-8"), '{"owner":"user"}\n')
            self.assertFalse(state_path.exists())


if __name__ == "__main__":
    unittest.main()
