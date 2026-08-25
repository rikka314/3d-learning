#!/usr/bin/env python3
"""Zero-dependency smoke tests for the paper-reading skill package."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=30,
    )


def test_skill_package_contract() -> None:
    result = run("scripts/validate_skill.py", ".", "--strict", "--json")
    assert result.returncode == 0, result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["summary"]["error_count"] == 0
    assert report["summary"]["warning_count"] == 0


def test_trigger_eval_coverage() -> None:
    data = json.loads((ROOT / "evals" / "evals.json").read_text(encoding="utf-8"))
    rows = data["evals"]
    positives = [row for row in rows if row["should_trigger"] is True]
    negatives = [row for row in rows if row["should_trigger"] is False]
    assert len(positives) >= 6
    assert len(negatives) >= 6
    assert any(row.get("mode") == "direct-comparison" for row in positives)
    assert any(row.get("mode") == "general-html-development" for row in negatives)
    assert any(row.get("mode") == "repository-review" for row in negatives)


def test_html_contract() -> None:
    result = run(
        "scripts/validate_paper_html.py",
        "assets/minimal-paper.html",
        "--contract",
        "--strict",
        "--json",
    )
    assert result.returncode == 0, result.stdout
    report = json.loads(result.stdout)
    assert report["summary"]["ok"] is True


def test_python_scripts_compile() -> None:
    result = run(
        "-m",
        "py_compile",
        "scripts/bridge.py",
        "scripts/validate_skill.py",
        "scripts/validate_paper_html.py",
        "tests/smoke_test.py",
    )
    assert result.returncode == 0, result.stdout


def test_bridge_rejects_unauthenticated_non_loopback() -> None:
    result = run(
        "scripts/bridge.py",
        "--host",
        "0.0.0.0",
        "--page",
        "assets/minimal-paper.html",
    )
    assert result.returncode != 0
    assert "--token is required when --host is not loopback" in result.stdout


def main() -> int:
    tests = [
        test_skill_package_contract,
        test_trigger_eval_coverage,
        test_html_contract,
        test_python_scripts_compile,
        test_bridge_rejects_unauthenticated_non_loopback,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"PASS all ({len(tests)} tests)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
