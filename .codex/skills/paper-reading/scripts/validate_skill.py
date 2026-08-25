#!/usr/bin/env python3
"""Zero-dependency validator for an Agent Skills package."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

ALLOWED_TOP_LEVEL = {
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
}
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", re.S)
LOCAL_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
RESOURCE_PATH_RE = re.compile(
    r"(?<![\w./-])((?:references|assets|scripts|evals|tests)/[A-Za-z0-9_.\-/]+)"
)
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


@dataclass
class Issue:
    level: str
    code: str
    message: str


def scalar_value(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        try:
            return str(json.loads(raw))
        except json.JSONDecodeError:
            return raw[1:-1]
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1].replace("''", "'")
    return raw


def parse_frontmatter(text: str) -> tuple[dict[str, str], dict[str, str], list[Issue]]:
    issues: list[Issue] = []
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, {}, [Issue("error", "frontmatter.missing", "SKILL.md must begin with YAML frontmatter.")]

    top: dict[str, str] = {}
    metadata: dict[str, str] = {}
    current_top: str | None = None

    for lineno, line in enumerate(match.group(1).splitlines(), start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith((" ", "\t")):
            if ":" not in line:
                issues.append(Issue("error", "frontmatter.syntax", f"Line {lineno} is not a key-value field."))
                current_top = None
                continue
            key, raw = line.split(":", 1)
            key = key.strip()
            top[key] = raw.strip()
            current_top = key
        elif current_top == "metadata":
            stripped = line.strip()
            if ":" not in stripped:
                issues.append(Issue("error", "metadata.syntax", f"Line {lineno} is not a metadata key-value field."))
                continue
            key, raw = stripped.split(":", 1)
            metadata[key.strip()] = raw.strip()

    return top, metadata, issues


def estimate_tokens(text: str) -> int:
    cjk = len(CJK_RE.findall(text))
    non_cjk = max(0, len(text) - cjk)
    return math.ceil(cjk * 1.1 + non_cjk / 4)


def iter_local_references(text: str) -> Iterable[str]:
    seen: set[str] = set()
    for match in LOCAL_LINK_RE.finditer(text):
        target = match.group(1).strip().split("#", 1)[0]
        if not target or "://" in target or target.startswith(("#", "mailto:")):
            continue
        seen.add(target)
    for match in RESOURCE_PATH_RE.finditer(text):
        target = match.group(1).rstrip(".,;:)")
        if "<" in target or ">" in target:
            continue
        seen.add(target)
    yield from sorted(seen)



def validate_markdown_links(root: Path, issues: list[Issue]) -> None:
    for markdown in sorted(root.rglob("*.md")):
        try:
            text = markdown.read_text(encoding="utf-8")
        except OSError as exc:
            issues.append(Issue("error", "markdown.read", f"Cannot read {markdown.relative_to(root)}: {exc}"))
            continue
        for match in LOCAL_LINK_RE.finditer(text):
            target = match.group(1).strip().split("#", 1)[0]
            if not target or "://" in target or target.startswith(("#", "mailto:")):
                continue
            resolved = (markdown.parent / target).resolve()
            try:
                resolved.relative_to(root)
            except ValueError:
                issues.append(Issue("error", "markdown.link_escape", f"{markdown.relative_to(root)} links outside the skill: {target}"))
                continue
            if not resolved.exists():
                issues.append(Issue("error", "markdown.broken_link", f"{markdown.relative_to(root)} has a broken local link: {target}"))

def validate_evals(root: Path, issues: list[Issue]) -> None:
    path = root / "evals" / "evals.json"
    if not path.exists():
        issues.append(Issue("error", "evals.missing", "evals/evals.json is required for routing regression tests."))
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        issues.append(Issue("error", "evals.invalid_json", f"Cannot parse {path.relative_to(root)}: {exc}"))
        return

    rows = data.get("evals")
    if not isinstance(rows, list):
        issues.append(Issue("error", "evals.schema", "evals must be a JSON array."))
        return

    positive = 0
    negative = 0
    ids: set[str] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            issues.append(Issue("error", "evals.row", f"Eval row {index} must be an object."))
            continue
        missing = [key for key in ("id", "prompt", "should_trigger", "expected_behavior", "files") if key not in row]
        if missing:
            issues.append(Issue("error", "evals.fields", f"Eval row {index} is missing: {', '.join(missing)}."))
        row_id = str(row.get("id", ""))
        if row_id in ids:
            issues.append(Issue("error", "evals.duplicate_id", f"Duplicate eval id: {row_id}."))
        ids.add(row_id)
        flag = row.get("should_trigger")
        if flag is True:
            positive += 1
        elif flag is False:
            negative += 1
        else:
            issues.append(Issue("error", "evals.trigger_type", f"Eval {row_id or index} should_trigger must be boolean."))

    if positive < 6:
        issues.append(Issue("warn", "evals.positive_coverage", f"Only {positive} positive trigger cases; at least 6 are recommended."))
    if negative < 6:
        issues.append(Issue("warn", "evals.negative_coverage", f"Only {negative} negative trigger cases; at least 6 are recommended."))


def validate(root: Path) -> dict[str, object]:
    root = root.resolve()
    issues: list[Issue] = []
    skill_path = root / "SKILL.md"
    if not skill_path.exists():
        issues.append(Issue("error", "skill.missing", "SKILL.md does not exist."))
        return make_report(root, issues, 0, 0)

    text = skill_path.read_text(encoding="utf-8")
    top, metadata, parse_issues = parse_frontmatter(text)
    issues.extend(parse_issues)

    unexpected = sorted(set(top) - ALLOWED_TOP_LEVEL)
    if unexpected:
        issues.append(Issue("error", "frontmatter.unexpected", f"Unexpected top-level fields: {unexpected}."))

    for required in ("name", "description"):
        if not scalar_value(top.get(required, "")):
            issues.append(Issue("error", f"frontmatter.{required}", f"Frontmatter field '{required}' is required."))

    name = scalar_value(top.get("name", ""))
    description = scalar_value(top.get("description", ""))
    if name:
        if not NAME_RE.fullmatch(name):
            issues.append(Issue("error", "name.format", "name must use lowercase letters, digits, and single hyphens only."))
        if len(name) > 64:
            issues.append(Issue("error", "name.length", "name exceeds 64 characters."))
        if name != root.name:
            issues.append(Issue("error", "name.directory", f"name '{name}' must match parent directory '{root.name}'."))

    if description:
        if len(description) > 1024:
            issues.append(Issue("error", "description.length", f"description has {len(description)} characters; maximum is 1024."))
        if "Use when" not in description:
            issues.append(Issue("warn", "description.when", "description should explicitly say when to use the skill."))
        if "Do not use" not in description:
            issues.append(Issue("warn", "description.exclusions", "description should include major exclusion cases for precise routing."))

    for key, raw in metadata.items():
        lowered = raw.strip().lower()
        looks_non_string = (
            not raw.strip().startswith(("'", '"'))
            and (lowered in {"true", "false", "null", "~"} or re.fullmatch(r"[-+]?\d+(?:\.\d+)?", lowered))
        )
        if looks_non_string:
            issues.append(Issue("error", "metadata.value_type", f"metadata.{key} must be a string value."))

    line_count = len(text.splitlines())
    token_estimate = estimate_tokens(text)
    if line_count > 500:
        issues.append(Issue("error", "skill.lines", f"SKILL.md has {line_count} lines; keep it under 500."))
    if token_estimate > 5000:
        issues.append(Issue("warn", "skill.tokens", f"Estimated SKILL.md size is {token_estimate} tokens; under 5000 is recommended."))

    for forbidden in ("~/.claude/skills/", "~/.codex/skills/", "C:\\Users\\"):
        if forbidden in text:
            issues.append(Issue("error", "portability.absolute_install_path", f"SKILL.md contains product-specific install path: {forbidden}"))

    for ref in iter_local_references(text):
        if not (root / ref).exists():
            issues.append(Issue("error", "reference.missing", f"Referenced resource does not exist: {ref}"))

    validate_markdown_links(root, issues)

    references_dir = root / "references"
    if references_dir.exists():
        for reference in sorted(references_dir.glob("*.md")):
            reference_text = reference.read_text(encoding="utf-8")
            reference_lines = len(reference_text.splitlines())
            if reference_lines > 300 and not re.search(r"^## (?:目录|Table of Contents)\s*$", reference_text, re.M):
                issues.append(Issue(
                    "warn",
                    "reference.toc",
                    f"{reference.relative_to(root)} has {reference_lines} lines and should include a table of contents.",
                ))

    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if "__pycache__" in rel.parts or path.suffix in {".pyc", ".pyo"} or path.name in {".DS_Store", ".pytest_cache"}:
            issues.append(Issue("error", "package.cache", f"Generated cache file should not be packaged: {rel}"))

    validate_evals(root, issues)
    return make_report(root, issues, line_count, token_estimate)


def make_report(root: Path, issues: list[Issue], line_count: int, token_estimate: int) -> dict[str, object]:
    errors = sum(issue.level == "error" for issue in issues)
    warnings = sum(issue.level == "warn" for issue in issues)
    return {
        "root": str(root),
        "ok": errors == 0,
        "summary": {
            "error_count": errors,
            "warning_count": warnings,
            "skill_line_count": line_count,
            "estimated_skill_tokens": token_estimate,
        },
        "issues": [asdict(issue) for issue in issues],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate an Agent Skills package without third-party dependencies.")
    parser.add_argument("path", nargs="?", default=".", help="Skill directory. Defaults to the current directory.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as failures.")
    args = parser.parse_args(argv)

    report = validate(Path(args.path))
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        summary = report["summary"]
        print(f"Skill: {report['root']}")
        print(
            f"Errors: {summary['error_count']} | Warnings: {summary['warning_count']} | "
            f"Lines: {summary['skill_line_count']} | Estimated tokens: {summary['estimated_skill_tokens']}"
        )
        for issue in report["issues"]:
            print(f"[{issue['level'].upper()}] {issue['code']}: {issue['message']}")

    errors = int(report["summary"]["error_count"])
    warnings = int(report["summary"]["warning_count"])
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
