#!/usr/bin/env python3
"""Prepare deterministic pass evidence and record only root-authored AI review scores.

This helper never judges images, invents scores, bypasses gates, or mutates model source.
Run from any directory; all paths resolve from this workspace.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parent
IMG2THREEJS = WORKSPACE.parents[1]
UPSTREAM = IMG2THREEJS / "upstream"
FORGE = UPSTREAM / "forge"
SPEC = WORKSPACE / "object-sculpt-spec.json"
STATE = WORKSPACE / ".img2threejs" / "state.json"
REFERENCE = WORKSPACE / "reference.png"
GATES_REFERENCE = UPSTREAM / "grimoire" / "review" / "gates_reference.md"
SELF_CORRECTION = UPSTREAM / "grimoire" / "review" / "self_correction.md"


class ReviewError(RuntimeError):
    pass


def run(args: list[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=IMG2THREEJS, text=True, capture_output=True, encoding="utf-8")
    if result.returncode and not allow_failure:
        raise ReviewError(f"command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}{result.stderr}")
    return result


def parse_json_output(output: str) -> dict:
    start = output.find("{")
    if start < 0:
        raise ReviewError(f"command produced no JSON object:\n{output}")
    try:
        value = json.loads(output[start:])
    except json.JSONDecodeError as error:
        raise ReviewError(f"invalid JSON command output: {error}\n{output}") from error
    if not isinstance(value, dict):
        raise ReviewError("expected JSON object output")
    return value


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def require_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise ReviewError(f"missing {label}: {path}")
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_snapshot_manifest(review_dir: Path) -> None:
    manifest = json.loads(require_file(review_dir / "source-snapshot.json", "source snapshot manifest").read_text(encoding="utf-8"))
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ReviewError("source snapshot manifest contains no files")
    for entry in files:
        if not isinstance(entry, dict):
            raise ReviewError("malformed source snapshot entry")
        expected = entry.get("sha256")
        source = require_file(Path(str(entry.get("source"))), "snapshotted source")
        snapshot = require_file(review_dir / str(entry.get("snapshot")), "immutable source snapshot")
        if sha256(snapshot) != expected:
            raise ReviewError(f"source snapshot changed after prepare: {snapshot}")
        if sha256(source) != expected:
            raise ReviewError(f"live source changed before review was recorded: {source}")


def seal_evidence(pass_id: str, captures: Path, review_dir: Path) -> Path:
    excluded = {"completion-manifest.json", "root-review.json", "source-snapshot.json", "capture-snapshot.json"}
    artifacts = []
    for path in sorted(review_dir.rglob("*")):
        if not path.is_file() or path.name in excluded or "textures" in path.relative_to(review_dir).parts:
            continue
        artifacts.append({"path": str(path.relative_to(review_dir)), "sha256": sha256(path)})
    required = {"tier1.json", "comparison.json", "comparison.png", "multi-angle.json", "turntable.json", "interior-difference.json", "attachment-scope.json"}
    found = {item["path"] for item in artifacts}
    if not required.issubset(found):
        raise ReviewError(f"cannot seal incomplete review evidence: {sorted(required - found)}")
    path = review_dir / "completion-manifest.json"
    write_json(path, {
        "passId": pass_id,
        "iterationId": review_dir.name,
        "captureRoot": str(captures),
        "reference": {"path": str(REFERENCE), "sha256": sha256(REFERENCE)},
        "spec": {"path": str(SPEC), "sha256": sha256(SPEC)},
        "artifacts": artifacts,
    })
    return path


def verify_completion_manifest(pass_id: str, captures: Path, review_dir: Path) -> Path:
    path = require_file(review_dir / "completion-manifest.json", "completed evidence manifest")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("passId") != pass_id or payload.get("iterationId") != review_dir.name or payload.get("captureRoot") != str(captures):
        raise ReviewError("completion manifest does not bind this pass, iteration, and capture root")
    if payload.get("reference", {}).get("sha256") != sha256(REFERENCE) or payload.get("spec", {}).get("sha256") != sha256(SPEC):
        raise ReviewError("reference or spec changed after evidence was sealed")
    for entry in payload.get("artifacts", []):
        artifact = require_file(review_dir / str(entry.get("path")), "sealed diagnostic artifact")
        if sha256(artifact) != entry.get("sha256"):
            raise ReviewError(f"diagnostic evidence changed after sealing: {artifact}")
    return path


def verify_capture_manifest(captures: Path, review_dir: Path) -> None:
    manifest = json.loads(require_file(review_dir / "capture-snapshot.json", "capture snapshot manifest").read_text(encoding="utf-8"))
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ReviewError("capture snapshot manifest contains no files")
    for entry in files:
        path = require_file(captures / str(entry.get("name")), "captured evidence")
        if sha256(path) != entry.get("sha256"):
            raise ReviewError(f"capture changed after prepare: {path}")


def shell_geometry_hash(runtime_report: Path) -> str:
    payload = json.loads(require_file(runtime_report, "runtime geometry report").read_text(encoding="utf-8"))
    geometry = next((item for item in payload.get("geometry", []) if item.get("id") == "ventricular-body-surface"), None)
    if not isinstance(geometry, dict):
        raise ReviewError("runtime report has no ventricular-body-surface geometry")
    stable = {key: geometry.get(key) for key in ("id", "vertices", "normals", "indices")}
    return hashlib.sha256(json.dumps(stable, separators=(",", ":")).encode("utf-8")).hexdigest()


def validate_self_intersection(captures: Path, pass_id: str) -> tuple[Path, Path | None]:
    path = require_file(captures / "self-intersection.json", "self-intersection evidence")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("selfIntersecting") is not False:
        raise ReviewError("self-intersection gate did not report a clean shell")
    if not isinstance(payload.get("sampledVertexCount"), int) or payload["sampledVertexCount"] <= 0:
        raise ReviewError("self-intersection evidence sampled no vertices")
    if payload.get("insideVertexCount") != 0 or payload.get("errors"):
        raise ReviewError("self-intersection evidence contains inside vertices or errors")
    meshes = payload.get("meshes")
    if not isinstance(meshes, list) or not meshes:
        raise ReviewError("self-intersection evidence contains no analyzed meshes")
    if any(item.get("normalSource") != "vertexNormals" for item in meshes if isinstance(item, dict)):
        raise ReviewError("self-intersection evidence must use exported vertex normals")
    provenance_path = captures / "self-intersection-provenance.json"
    if pass_id in {"material-pass", "surface-pass", "lighting-pass", "interaction-pass", "optimization-pass"}:
        provenance = json.loads(require_file(provenance_path, "reused shell-check provenance").read_text(encoding="utf-8"))
        if provenance.get("selfIntersectionSha256") != sha256(path):
            raise ReviewError("self-intersection provenance does not bind the supplied gate result")
        current_hash = shell_geometry_hash(captures / "runtime-report.json")
        if provenance.get("currentShellGeometrySha256") != current_hash or provenance.get("sourceShellGeometrySha256") != current_hash:
            raise ReviewError("reused self-intersection evidence does not match the current shell geometry")
        source = require_file(Path(str(provenance.get("sourceEvidence"))), "original self-intersection evidence")
        if sha256(source) != sha256(path):
            raise ReviewError("reused self-intersection result differs from its immutable source")
        return path, provenance_path
    return path, provenance_path if provenance_path.is_file() else None


def prepare(pass_id: str, captures: Path, review_dir: Path) -> None:
    front = require_file(captures / "front.png", "front capture")
    right = require_file(captures / "right.png", "right capture")
    rear = require_file(captures / "rear.png", "rear capture")
    left = require_file(captures / "left.png", "left capture")
    three_quarter = require_file(captures / "threeQuarter.png", "three-quarter capture")
    review_dir.mkdir(parents=True, exist_ok=True)
    for stale_name in (
        "tier1.json", "comparison.json", "comparison.png", "multi-angle.json", "turntable.json",
        "interior-difference.json", "attachment-scope.json", "completion-manifest.json",
    ):
        (review_dir / stale_name).unlink(missing_ok=True)
    snapshot_entries = []
    sources = [
        WORKSPACE / "src" / "createHeartModel.ts",
        WORKSPACE / "src" / "heartMaterials.ts",
        WORKSPACE / "src" / "main.ts",
        WORKSPACE / "anatomy-layout.json",
    ]
    sources.extend(sorted((WORKSPACE / "public" / "textures").glob("*.png")))
    for source in sources:
        if source.is_file():
            destination = review_dir / (Path("textures") / source.name if source.parent.name == "textures" else source.name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            snapshot_entries.append({
                "source": str(source),
                "snapshot": str(destination.relative_to(review_dir)),
                "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
            })
    write_json(review_dir / "source-snapshot.json", {
        "passId": pass_id,
        "files": snapshot_entries,
        "limitation": "No separately preserved blockout source snapshot exists; snapshots begin with structural-pass.",
    })
    capture_names = ["front.png", "right.png", "rear.png", "left.png", "threeQuarter.png"]
    capture_names += [name for name in ("neutral.png", "grazing.png", "runtime-report.json", "self-intersection.json", "self-intersection-provenance.json") if (captures / name).is_file()]
    write_json(review_dir / "capture-snapshot.json", {
        "passId": pass_id,
        "files": [{"name": name, "sha256": sha256(captures / name)} for name in capture_names],
    })

    tier1_command = [
        sys.executable, str(FORGE / "stage4_review" / "diagnose_render.py"),
        "--reference", str(REFERENCE), "--render", str(front), "--spec", str(SPEC),
        "--pass-id", pass_id, "--in-place", "--json",
    ]
    if pass_id == "blockout":
        tier1_command += ["--map-stripped-render", str(front)]
    tier1_result = run(tier1_command, allow_failure=True)
    tier1 = parse_json_output(tier1_result.stdout)
    write_json(review_dir / "tier1.json", tier1)

    comparison = parse_json_output(run([
        sys.executable, str(FORGE / "stage4_review" / "make_comparison_sheet.py"),
        "--reference", str(REFERENCE), "--render", str(front),
        "--out", str(review_dir / "comparison.png"),
        "--panel-width", "720", "--panel-height", "900", "--json",
    ]).stdout)
    write_json(review_dir / "comparison.json", comparison)

    multi = parse_json_output(run([
        sys.executable, str(FORGE / "stage4_review" / "diagnose_render_multi_angle.py"),
        "--reference", str(front), "--orbit", str(right), "--orbit", str(rear),
        "--orbit", str(left), "--orbit", str(three_quarter), "--json",
    ]).stdout)
    write_json(review_dir / "multi-angle.json", multi)
    if multi.get("degenerate") is True:
        raise ReviewError("multi-angle gate found a degenerate view")

    turntable = parse_json_output(run([
        sys.executable, str(FORGE / "stage4_review" / "turntable_gate.py"),
        "--capture", f"0={front}", "--capture", f"90={right}",
        "--capture", f"180={rear}", "--capture", f"270={left}", "--json",
    ]).stdout)
    write_json(review_dir / "turntable.json", turntable)
    if turntable.get("passed") is not True:
        raise ReviewError("turntable coverage/hole gate failed")

    interior = parse_json_output(run([
        sys.executable, str(FORGE / "stage4_review" / "interior_difference.py"),
        str(REFERENCE), str(front), "--json",
    ]).stdout)
    write_json(review_dir / "interior-difference.json", interior)
    if interior.get("status") != "measured":
        raise ReviewError("interior difference was not measured")

    attachment_scope = {
        "passId": pass_id,
        "applicability": "unmeasured",
        "reason": "Great vessels are embedded tissue connections rather than worn/held attachments. Runtime socket roots exist, but this helper has no independent measured attachment-anchor payload.",
        "claimLimit": "No attachment-anchor pass is claimed; visual root continuity and separate self-intersection evidence remain required.",
    }
    write_json(review_dir / "attachment-scope.json", attachment_scope)
    seal_evidence(pass_id, captures, review_dir)
    print(json.dumps({"ok": True, "passId": pass_id, "comparison": str(review_dir / "comparison.png"), "reviewDir": str(review_dir)}, indent=2))


def numeric(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
        raise ReviewError(f"{label} must be a number from 0 to 1")
    return float(value)


def mark(step: str, evidence: Path) -> None:
    run([sys.executable, str(FORGE / "state.py"), "mark", step, "--state", str(STATE), "--evidence", str(evidence)])


def record(pass_id: str, captures: Path, review_dir: Path, review_path: Path) -> None:
    require_file(review_path, "root-authored review JSON")
    payload = json.loads(review_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("authoredBy") != "root":
        raise ReviewError('review JSON must be an object with authoredBy="root"')
    action = payload.get("action")
    if action not in {"continue", "refine-code", "refine-spec", "request-input", "stop"}:
        raise ReviewError("root review must provide an explicit valid action")
    fidelity = numeric(payload.get("estimatedFidelity"), "estimatedFidelity")
    ai_score = numeric(payload.get("aiVisionScore"), "aiVisionScore")
    summary = payload.get("summary")
    notes = payload.get("notes")
    layers = payload.get("layerScores")
    features = payload.get("featureReviews")
    if not isinstance(summary, str) or not summary.strip() or not isinstance(notes, str) or not notes.strip():
        raise ReviewError("root review must provide summary and notes")
    if not isinstance(layers, dict) or not layers:
        raise ReviewError("root review must provide explicit layerScores")
    for key, value in layers.items():
        numeric(value, f"layerScores.{key}")
    if not isinstance(features, list):
        raise ReviewError("root review must provide featureReviews")
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or not isinstance(feature.get("id"), str):
            raise ReviewError(f"featureReviews[{index}] needs id")
        numeric(feature.get("score"), f"featureReviews[{index}].score")

    verify_snapshot_manifest(review_dir)
    verify_capture_manifest(captures, review_dir)
    completion_manifest = verify_completion_manifest(pass_id, captures, review_dir)
    self_intersection, self_intersection_provenance = validate_self_intersection(captures, pass_id)

    tier1 = json.loads(require_file(review_dir / "tier1.json", "Tier 1 evidence").read_text(encoding="utf-8"))
    multi = json.loads(require_file(review_dir / "multi-angle.json", "multi-angle evidence").read_text(encoding="utf-8"))
    turntable = json.loads(require_file(review_dir / "turntable.json", "turntable evidence").read_text(encoding="utf-8"))
    interior = json.loads(require_file(review_dir / "interior-difference.json", "interior evidence").read_text(encoding="utf-8"))
    if multi.get("degenerate") is True or turntable.get("passed") is not True or interior.get("status") != "measured":
        raise ReviewError("deterministic evidence is incomplete or failing")
    if tier1.get("passed") is not True and action == "continue":
        raise ReviewError("Tier 1 failed; a continue review is forbidden, but a correction action may be recorded")

    layers_path = review_dir / "layer-scores.json"
    features_path = review_dir / "feature-reviews.json"
    write_json(layers_path, layers)
    write_json(features_path, features)
    front = require_file(captures / "front.png", "front capture")
    comparison = require_file(review_dir / "comparison.png", "comparison image")
    evidence = [front, captures / "threeQuarter.png", review_dir / "tier1.json", review_dir / "multi-angle.json", review_dir / "turntable.json", review_dir / "interior-difference.json", review_dir / "attachment-scope.json"]
    evidence.extend([review_dir / "source-snapshot.json", review_dir / "capture-snapshot.json", completion_manifest, self_intersection])
    if self_intersection_provenance is not None:
        evidence.append(self_intersection_provenance)
    material_dir = review_dir / "material"
    if pass_id == "material-pass":
        evidence.extend(require_file(material_dir / name, f"material evidence {name}") for name in (
            "view-plan.json", "myocardium-comparison.json", "arterial-comparison.json",
            "venous-comparison.json", "fat-comparison.json", "atrial-comparison.json", "material-gate.json",
        ))
        material_gate = json.loads((material_dir / "material-gate.json").read_text(encoding="utf-8"))
        if material_gate.get("passed") is not True and action == "continue":
            raise ReviewError("material gate failed; a continue review is forbidden")

    command = [
        sys.executable, str(FORGE / "stage4_review" / "append_review.py"), str(SPEC),
        "--pass-id", pass_id, "--fidelity", str(fidelity), "--action", action,
        "--summary", summary, "--evidence", ";".join(str(path) for path in evidence),
        "--reference-screenshot", str(REFERENCE), "--render-screenshot", str(front),
        "--comparison-image", str(comparison), "--ai-vision-score", str(ai_score),
        "--layer-scores-json", str(layers_path), "--feature-reviews-json", str(features_path),
        "--ai-vision-notes", notes, "--camera-view", "reference",
        "--visual-notes", "Single-source stylized teaching model; unseen rear/depth remain inferred.",
        "--require-screenshot-files", "--in-place",
    ]
    if pass_id == "blockout":
        command += ["--map-stripped-render", str(front)]
    run(command)

    mark("render-capture", front)
    mark("review-contract-read", GATES_REFERENCE)
    mark("tier1-diagnostics", review_dir / "tier1.json")
    mark("multi-angle-review", review_dir / "multi-angle.json")
    if action == "continue":
        check = run([sys.executable, str(FORGE / "stage3_build" / "orchestrate_passes.py"), "check", str(SPEC), "--pass-id", pass_id, "--json"])
        write_json(review_dir / "pass-gate.json", parse_json_output(check.stdout))
    else:
        write_json(review_dir / "pass-gate.json", {"ok": False, "passId": pass_id, "action": action, "reason": "Root selected a non-continue correction action."})
    mark("pass-gate-check", review_dir / "pass-gate.json")
    mark("ai-review-recorded", review_path)
    run([sys.executable, str(FORGE / "stage3_build" / "orchestrate_passes.py"), "sync", str(SPEC), "--in-place"])
    mark("pipeline-sync", SPEC)
    next_result = run([sys.executable, str(FORGE / "next.py"), "--state", str(STATE), str(SPEC)])
    print(next_result.stdout, end="")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)
    for name in ("prepare", "seal", "record"):
        item = sub.add_parser(name)
        item.add_argument("--pass-id", required=True)
        item.add_argument("--captures", type=Path)
        item.add_argument("--review-dir", type=Path)
        if name == "record":
            item.add_argument("--review", type=Path, required=True, help='Root-authored JSON with authoredBy="root" and explicit scores/action')
    return result


def main(argv: list[str]) -> int:
    args = parser().parse_args(argv)
    captures = (args.captures or WORKSPACE / "output" / "playwright" / args.pass_id).resolve()
    review_dir = (args.review_dir or WORKSPACE / "output" / "reviews" / args.pass_id).resolve()
    try:
        if args.command == "prepare":
            prepare(args.pass_id, captures, review_dir)
        elif args.command == "seal":
            print(seal_evidence(args.pass_id, captures, review_dir))
        else:
            record(args.pass_id, captures, review_dir, args.review.resolve())
        return 0
    except (OSError, json.JSONDecodeError, ReviewError) as error:
        print(f"review error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
