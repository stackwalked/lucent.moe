# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Runs clang-tidy over one native project's translation units.

The project's header-verification units count as its own: they are how public headers get linted
on their own, outside any includer.
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


def main() -> int:
    if len(sys.argv) != 2:  # noqa: PLR2004 -- program name plus the project directory
        print("usage: tidy.py <native project directory>", file=sys.stderr)
        return 2
    project = Path(sys.argv[1]).resolve()
    units = translation_units(project)
    if not units:
        print(f"tidy: no translation units under {project}; configure first", file=sys.stderr)
        return 1
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
