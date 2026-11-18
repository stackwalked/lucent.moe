# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""TypeScript workspace hygiene checks that Biome and tsc cannot express.

1. Every dependency version in any tracked package.json is an exact release pin (x.y.z or
   x.y.z-tag) or `workspace:*`; semver ranges (^, ~, *, >=, <, latest) are rejected.
2. Junk-drawer module filenames (utils, helpers, common, types) are banned under TS roots.
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import cast

EXACT_PIN = re.compile(r"^(?:workspace:\*|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$")

DEPENDENCY_FIELDS = (
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
)

TS_ROOTS = ("contracts/", "products/", "platform/", "web/")
TS_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts"})
BANNED_STEMS = frozenset({"utils", "util", "helpers", "helper", "common", "types"})


def _bad_pin_msg(rel_path: str, field: str, pkg: str, spec: object) -> str:
    return f"{rel_path}: {field}.{pkg} must be an exact version or workspace:*, got {spec!r}"


def check_package_json(rel_path: str, raw_json: str) -> list[str]:
    parsed = cast("dict[str, object]", json.loads(raw_json))
    findings: list[str] = []
    for field in DEPENDENCY_FIELDS:
        section = parsed.get(field)
        if not isinstance(section, dict):
            continue
        entries = cast("dict[str, object]", section)
        for pkg, spec in entries.items():
            if not isinstance(spec, str) or not EXACT_PIN.match(spec):
                findings.append(_bad_pin_msg(rel_path, field, pkg, spec))
    return findings


def check_filename(rel_path: str) -> str | None:
    if not rel_path.startswith(TS_ROOTS):
        return None
    path = Path(rel_path)
    if path.suffix not in TS_SUFFIXES:
        return None
    stem = path.stem.removesuffix(".test")
    if stem in BANNED_STEMS:
        return f"{rel_path}: junk-drawer filename `{path.name}` is banned; name it for its domain"
    return None


def _candidate_files() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [name for name in listed.stdout.split("\0") if name]


def main() -> int:
    findings: list[str] = []
    for rel_path in _candidate_files():
        path = Path(rel_path)
        if not path.is_file():
            continue
        if path.name == "package.json":
            findings.extend(check_package_json(rel_path, path.read_text(encoding="utf-8")))
        name_error = check_filename(rel_path)
        if name_error is not None:
            findings.append(name_error)
    for finding in findings:
        print(finding)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
