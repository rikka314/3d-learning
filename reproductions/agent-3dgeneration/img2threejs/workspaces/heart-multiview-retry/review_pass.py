"""Run existing img2threejs diagnostics. This script never assigns visual scores."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FORGE = ROOT.parents[1] / "upstream" / "forge"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage")
    parser.add_argument("pass_id")
    args = parser.parse_args()
    directory = (ROOT / "output" / args.stage).resolve()
    if directory.parent != (ROOT / "output").resolve() or not directory.is_dir():
        parser.error("Expected an existing stage folder under output")
    runs = []

    def run(script, flags, output):
        command = [sys.executable, "-X", "utf8", str(FORGE / script), *map(str, flags)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        (directory / output).write_text(result.stdout, encoding="utf-8")
        runs.append({"command":command, "exitCode":result.returncode, "output":output, "stderr":result.stderr})
        (directory / "diagnostic-runs.json").write_text(json.dumps(runs, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{output}: exit={result.returncode}", flush=True)
        if result.returncode not in (0,1):
            raise RuntimeError(result.stderr or result.stdout)
        if script.endswith(("interior_difference.py", "make_multiview_comparison.py")) and result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        if "--json" in flags:
            payload = json.loads(result.stdout)
            if not isinstance(payload, dict) or "error" in payload:
                raise RuntimeError(f"Malformed diagnostic output: {output}")

    views = ["front", "left", "rear", "right"]
    for view in views:
        flags = ["--reference", ROOT / "references" / f"{view}.png", "--render", directory / f"{view}.png", "--json"]
        if view == "front":
            flags += ["--spec", ROOT / "object-sculpt-spec.json", "--pass-id", args.pass_id, "--in-place"]
            if args.pass_id == "blockout":
                flags += ["--map-stripped-render", directory / "map-stripped.png"]
        run("stage4_review/diagnose_render.py", flags, f"tier1-{view}.json")
        run("stage4_review/interior_difference.py", [ROOT / "references" / f"{view}.png", directory / f"{view}.png", "--json"], f"interior-{view}.json")
    run("stage4_review/diagnose_render_multi_angle.py", ["--reference", directory / "front.png", "--orbit", directory / "left.png", "--orbit", directory / "rear.png", "--orbit", directory / "right.png", "--json"], "multi-angle.json")
    run("stage4_review/turntable_gate.py", ["--capture", f"0={directory / 'front.png'}", "--capture", f"90={directory / 'left.png'}", "--capture", f"180={directory / 'rear.png'}", "--capture", f"270={directory / 'right.png'}", "--allow-holes", "--json"], "turntable.json")
    run("stage4_review/self_intersection.py", [directory / "geometry.json", "--json"], "shell-intersection.json")
    run("stage3_build/orchestrate_passes.py", ["check", ROOT / "object-sculpt-spec.json", "--pass-id", args.pass_id, "--json"], "pass-gate.json")
    run("stage4_review/make_multiview_comparison.py", ["--reference", *[f"{v}={ROOT / 'references' / (v+'.png')}" for v in views], "--render", *[f"{v}={directory / (v+'.png')}" for v in views], "--out-dir", directory / "comparisons", "--out", directory / "matched-review.json"], "comparison-command.txt")
    (directory / "diagnostic-runs.json").write_text(json.dumps(runs, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
