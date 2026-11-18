# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Runs a repo-wide file check over what a commit will contain.

Inside a commit hook git names the index being committed in GIT_INDEX_FILE (a temporary one for
`git commit -- <paths>`). The check then runs over that index exported to a scratch tree, so in a
checkout several sessions share, another session's unstaged edits and untracked files can't fail
it, and a broken file left unstaged can't slip past it. Outside a hook it runs in place.

Usage: staged.py <command> [arguments...], from the workspace root.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _git_dir(root: Path) -> Path:
    found = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        capture_output=True,
        text=True,
        check=True,
        cwd=root,
    )
    return Path(found.stdout.strip())


def run_on_index(command: list[str], index: Path, root: Path) -> int:
    scratch = Path(tempfile.mkdtemp(prefix="staged-", dir=root / ".moon" / "cache"))
    try:
        # A copy, so nothing the check runs can rewrite the real index with the scratch tree's
        # file stats.
        copied_index = scratch / "index"
        _ = shutil.copyfile(index, copied_index)
        tree = scratch / "tree"
        tree.mkdir()
        environment = os.environ | {
            "GIT_DIR": str(_git_dir(root)),
            "GIT_WORK_TREE": str(tree),
            "GIT_INDEX_FILE": str(copied_index),
            "GIT_OPTIONAL_LOCKS": "0",
            # uv would otherwise build a fresh environment inside the scratch tree.
            "UV_PROJECT_ENVIRONMENT": str(root / ".venv"),
        }
        _ = subprocess.run(
            ["git", "checkout-index", "--all", f"--prefix={tree}/"], check=True, env=environment
        )
        return subprocess.run(command, cwd=tree, env=environment, check=False).returncode
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def main() -> int:
    command = sys.argv[1:]
    if not command:
        print("usage: staged.py <command> [arguments...]", file=sys.stderr)
        return 2
    index = os.environ.get("GIT_INDEX_FILE")
    if not index:
        return subprocess.run(command, cwd=ROOT, check=False).returncode
    # git hands hooks a path relative to the worktree root, which is where moon runs repo tasks.
    return run_on_index(command, (ROOT / index).resolve(), ROOT)


if __name__ == "__main__":
    sys.exit(main())
