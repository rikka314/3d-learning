from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "forge" / "_shared"))

from workflow_state import new_state  # noqa: E402


def write_png(
    path: Path,
    accent: tuple[int, int, int],
    *,
    size: int = 96,
    shape: str = "wide",
) -> None:
    width = height = size
    rows: list[bytes] = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            if shape == "l-shape":
                foreground = (
                    18 <= x < 40 and 10 <= y < 86
                ) or (
                    18 <= x < 82 and 62 <= y < 84
                )
            else:
                foreground = 16 <= x < 80 and 12 <= y < 84
            color = accent if foreground else (245, 245, 245)
            row.extend(color)
        rows.append(bytes(row))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


class ReferenceSetIntakeTest(unittest.TestCase):
    def test_workflow_routes_reference_admission_through_reference_set_intake(self) -> None:
        state = new_state("reference.png")
        admission = next(item for item in state["checklist"] if item["id"] == "reference-admission")

        self.assertIn("process_reference_set.py", admission["command"])
        self.assertIn("{reference_set}", admission["command"])

    def test_processes_every_view_and_preserves_view_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            side = root / "side.png"
            manifest = root / "references.json"
            output = root / "evidence.json"
            write_png(front, (180, 60, 40))
            write_png(side, (40, 80, 180), shape="l-shape")
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "primaryViewId": "front",
                        "views": [
                            {"id": "front", "role": "front", "path": "front.png", "camera": {"fovDegrees": 40}},
                            {"id": "side", "role": "right", "path": "side.png", "evidence": {"mask": "side-mask.png"}},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "stage1_intake" / "process_reference_set.py"),
                    str(manifest),
                    "--out",
                    str(output),
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["primaryViewId"], "front")
            self.assertEqual([item["viewId"] for item in payload["views"]], ["front", "side"])
            self.assertEqual(payload["views"][0]["camera"], {"fovDegrees": 40})
            self.assertEqual(payload["views"][1]["evidence"], {"mask": "side-mask.png"})
            self.assertEqual(payload["summary"]["viewCount"], 2)
            self.assertTrue(all("technicalProbe" in item and "admission" in item for item in payload["views"]))

    def test_direct_intake_api_returns_versioned_summary(self) -> None:
        from forge.stage1_intake.process_reference_set import main as intake_main
        from forge.stage1_intake.process_reference_set import process_reference_set

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front = root / "front.png"
            manifest = root / "references.json"
            write_png(front, (180, 60, 40))
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "primaryViewId": "front",
                        "views": [{"id": "front", "path": "front.png"}],
                    }
                ),
                encoding="utf-8",
            )

            payload = process_reference_set(manifest)

            self.assertEqual(payload["kind"], "img2threejs.reference-set-intake")
            self.assertEqual(payload["summary"]["viewCount"], 1)
            self.assertIn(payload["summary"]["status"], {"proceed", "request-input"})

            output = root / "direct-evidence.json"
            with redirect_stdout(StringIO()):
                result = intake_main([str(manifest), "--out", str(output)])

            self.assertEqual(result, 0)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8"))["primaryViewId"],
                "front",
            )

    def test_missing_view_fails_before_writing_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "references.json"
            output = root / "evidence.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "views": [{"id": "front", "path": "missing.png"}],
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "stage1_intake" / "process_reference_set.py"),
                    str(manifest),
                    "--out",
                    str(output),
                ],
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            self.assertIn("does not exist", result.stderr)

    def test_rejected_view_returns_nonzero_request_input_status(self) -> None:
        from forge.stage1_intake.process_reference_set import main as intake_main

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tiny = root / "tiny.png"
            manifest = root / "references.json"
            output = root / "evidence.json"
            write_png(tiny, (180, 60, 40), size=16)
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "views": [{"id": "front", "path": "tiny.png"}],
                    }
                ),
                encoding="utf-8",
            )

            with redirect_stdout(StringIO()):
                result = intake_main([str(manifest), "--out", str(output)])

            self.assertNotEqual(result, 0)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8"))["summary"]["status"],
                "request-input",
            )


if __name__ == "__main__":
    unittest.main()
