"""Crop the supplied sheet without synthesizing pixels; retain crop provenance."""
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent


def main():
    if (ROOT / "references.json").exists():
        raise FileExistsError("Reference intake already exists; do not overwrite reviewed references")
    source = ROOT / "reference-sheet.png"
    sheet = Image.open(source).convert("RGB")
    boxes = {"front": (144, 5, 566, 626), "left": (700, 14, 1055, 582),
             "rear": (132, 642, 518, 1183), "right": (754, 626, 1083, 1162)}
    views = []
    reference_dir = ROOT / "references"
    reference_dir.mkdir(exist_ok=True)
    for name, box in boxes.items():
        crop = sheet.crop(box)
        crop.save(reference_dir / f"{name}-crop.png")
        # Equal displayed height is an explicit framing estimate, not camera calibration.
        ratio = 790 / crop.height
        scaled = crop.resize((round(crop.width * ratio), 790), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (720, 900), "white")
        canvas.paste(scaled, ((720 - scaled.width) // 2, 55))
        destination = reference_dir / f"{name}.png"
        canvas.save(destination)
        views.append({"id": name, "path": str(destination), "role": name,
                      "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
                      "evidence": {"sheetCropXYXY": box, "normalization": "uniform scale to 790 px crop height; centered on 720x900 white canvas",
                                   "orientation": "anatomical left is +X, anterior is +Z; nominal orthographic only"}})
    manifest = {"schemaVersion": 1, "kind": "img2threejs.reference-set", "mode": "vision-context",
                "primaryViewId": "front", "views": views,
                "source": {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
                "limitations": "Four illustrated views; neither calibrated nor guaranteed geometrically exact."}
    (ROOT / "references.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (ROOT / "public" / "reference-sheet.png").write_bytes(source.read_bytes())
    print(json.dumps({"sourceSize": sheet.size, "views": list(boxes)}))


if __name__ == "__main__":
    main()
