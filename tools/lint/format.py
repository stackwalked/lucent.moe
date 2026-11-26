# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Checks or fixes formatting: dprint for docs and data, clang-format and gersemi for native.

clang-format and gersemi are not routed through dprint's exec plugin because it starts one
formatter process per file: 705 C++ files took over three minutes that way and take five seconds
in one process. Each is handed every file at once here.

Usage: format.py [--fix] [files...], from the tree to check. Without files, every tracked file.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

GERSEMI = [
    "uv",
    "run",
    "--frozen",
    "gersemi",
    "--line-length=100",
    "--indent=4",
    "--list-expansion=favour-inlining",
    "--no-warn-about-unknown-commands",
]


def is_cpp(name: str) -> bool:
    return PurePosixPath(name).suffix in {".cpp", ".hpp"}


def is_cmake(name: str) -> bool:
    path = PurePosixPath(name)
    return path.suffix == ".cmake" or path.name == "CMakeLists.txt"


def tracked() -> list[str]:
    listed = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True)
    return [name for name in listed.stdout.split("\0") if name]


def run_clang_format(files: list[str], *, fix: bool) -> int:
    # A response file: the tree's C++ paths together pass Windows' command-line limit.
    with tempfile.TemporaryDirectory() as scratch:
        listing = Path(scratch) / "files"
        _ = listing.write_text("\n".join(files), encoding="utf-8")
        mode = ["-i"] if fix else ["--dry-run", "-Werror"]
        return subprocess.run(["clang-format", *mode, f"--files={listing}"], check=False).returncode


def main() -> int:
    arguments = sys.argv[1:]
    fix = bool(arguments) and arguments[0] == "--fix"
    named = arguments[1:] if fix else arguments
    files = named or tracked()

    dprint = ["dprint", "fmt" if fix else "check", "--incremental=false", "--allow-no-files"]
    failed = subprocess.run([*dprint, *named], check=False).returncode != 0

    cpp = [name for name in files if is_cpp(name)]
    if cpp:
        failed = run_clang_format(cpp, fix=fix) != 0 or failed

    cmake = [name for name in files if is_cmake(name)]
    if cmake:
        mode = ["--in-place"] if fix else ["--check"]
        # This script's own environment is not the project's, and uv says so on every run.
        environment = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        gersemi = subprocess.run([*GERSEMI, *mode, *cmake], check=False, env=environment)
        failed = gersemi.returncode != 0 or failed

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
