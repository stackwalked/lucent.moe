# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Claude Code PostToolUse hook: format the file an agent just wrote.

Formatting only. Lint autofixes stay out: mid-edit they delete imports the agent
is about to use.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import cast

PYTHON = frozenset({".py", ".pyi"})
BIOME = frozenset({".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"})


def formatter_for(path: Path) -> list[str]:
    if path.suffix in PYTHON:
        return ["uv", "run", "--frozen", "ruff", "format", str(path)]
    if path.suffix in BIOME:
        return ["bun", "biome", "format", "--write", str(path)]
    # dprint knows its own includes and excludes; anything else is a no-op.
    return ["dprint", "fmt", "--allow-no-files", str(path)]


def main() -> int:
    event = cast("dict[str, dict[str, object]]", json.load(sys.stdin))
    file_path = event.get("tool_input", {}).get("file_path")
    if not isinstance(file_path, str):
        return 0
    path = Path(file_path)
    if not path.is_file():
        return 0
    formatted = subprocess.run(formatter_for(path), capture_output=True, text=True, check=False)
    if formatted.returncode != 0:
        print(formatted.stdout + formatted.stderr, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
