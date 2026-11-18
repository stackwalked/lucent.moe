# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Runs clang-tidy over one native project's translation units.

The project's header-verification units count as its own: they are how public headers get linted
on their own, outside any includer.

With --fix it applies misc-include-cleaner's fixes instead of reporting, then formats what changed:
the one check whose findings are pure bookkeeping, and whose fixes are always right. Only the
project's own sources are fixed (each touches only its main file, so they run in parallel safely);
the generated header-verification units are not.
"""

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import cast

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "native"
# The dev preset's binaryDir in native/CMakePresets.json.
BUILD = ROOT / ".moon" / "cache" / "cmake" / "dev"


def translation_units(project: Path) -> list[Path]:
    database = cast(
        "list[dict[str, str]]",
        json.loads((BUILD / "compile_commands.json").read_text(encoding="utf-8")),
    )
    built = BUILD / project.relative_to(NATIVE)
    units: list[Path] = []
    for entry in database:
        unit = Path(entry["directory"], entry["file"]).resolve()
        if unit.is_relative_to(project) or unit.is_relative_to(built):
            units.append(unit)
    return sorted(units)


def tidy(unit: Path) -> subprocess.CompletedProcess[str]:
    # Generated units in the build tree can't find native/.clang-tidy by walking up.
    config = [] if unit.is_relative_to(NATIVE) else [f"--config-file={NATIVE / '.clang-tidy'}"]
    return subprocess.run(
        ["clang-tidy", "-p", str(BUILD), "--quiet", *config, str(unit)],
        capture_output=True,
        text=True,
        check=False,
    )


def fix_one(unit: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "clang-tidy",
            "-p",
            str(BUILD),
            "--quiet",
            "--checks=-*,misc-include-cleaner",
            "--warnings-as-errors=-*",
            "--fix",
            str(unit),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def fix_includes(units: list[Path]) -> int:
    before = {unit: unit.read_bytes() for unit in units}
    with ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
        results = list(pool.map(fix_one, units))
    for result in results:
        if result.returncode != 0:
            print(result.stdout, end="")
            print(result.stderr, end="", file=sys.stderr)
    changed = [unit for unit in units if unit.read_bytes() != before[unit]]
    if changed:
        # The fixes insert includes where clang-tidy thinks they go; the formatter decides.
        _ = subprocess.run(["dprint", "fmt", *map(str, changed)], check=True, cwd=ROOT)
    for unit in changed:
        print(f"tidy: fixed includes in {unit.relative_to(ROOT)}")
    return 0 if all(result.returncode == 0 for result in results) else 1


def main() -> int:
    arguments = sys.argv[1:]
    should_fix = arguments[:1] == ["--fix"]
    if should_fix:
        arguments = arguments[1:]
    if len(arguments) != 1:
        print("usage: tidy.py [--fix] <native project directory>", file=sys.stderr)
        return 2
    project = Path(arguments[0]).resolve()
    units = translation_units(project)
    if not units:
        print(f"tidy: no translation units under {project}; configure first", file=sys.stderr)
        return 1
    if should_fix:
        return fix_includes([unit for unit in units if unit.is_relative_to(project)])
    with ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
        results = list(pool.map(tidy, units))
    failed = False
    for result in results:
        if result.returncode != 0:
            failed = True
            print(result.stdout, end="")
            print(result.stderr, end="", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
