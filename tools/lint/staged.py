# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Runs a repo-wide file check over what a commit will contain.

Inside a commit hook git names the index being committed in GIT_INDEX_FILE (a temporary one for
`git commit -- <paths>`). The check then runs over that index exported to a scratch tree, so in a
checkout several sessions share, another session's unstaged edits and untracked files can't fail
it, and a broken file left unstaged can't slip past it. Outside a hook it runs in place.

With --changed-unless=<globs>, a check that takes file arguments is given only the files the commit
adds or changes, so its cost follows the commit and not the tree. A commit touching a file that
matches one of the comma-separated globs (the check's own configuration and tool pins) still runs
over everything: a rule that changed has to be held against files the commit did not touch.

Usage: staged.py [--changed-unless=<globs>] <command> [arguments...], from the workspace root.
"""

import fnmatch
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


# Past this the file list risks the platform's command-line limit; the whole tree is the safe
# fallback, and a commit that large is rare.
MAX_LISTED_FILES = 300


def changed_files(environment: dict[str, str], full_run: list[str]) -> list[str] | None:
    """List the files the index adds or changes; None means everything must be checked."""
    listed = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
        env=environment,
    )
    # No HEAD yet: the first commit is the whole tree.
    if listed.returncode != 0:
        return None
    files = [name for name in listed.stdout.split("\0") if name]
    if len(files) > MAX_LISTED_FILES:
        return None
    if any(fnmatch.fnmatchcase(name, glob) for name in files for glob in full_run):
        return None
    return files


def run_on_index(
    command: list[str], index: Path, root: Path, full_run: list[str] | None = None
) -> int:
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
        if full_run is not None:
            files = changed_files(environment, full_run)
            if files is not None:
                # Nothing added or changed (a commit of deletions) leaves nothing to check.
                if not files:
                    return 0
                command = [*command, *files]
        return subprocess.run(command, cwd=tree, env=environment, check=False).returncode
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def main() -> int:
    command = sys.argv[1:]
    full_run: list[str] | None = None
    if command and command[0].startswith("--changed-unless="):
        full_run = [glob for glob in command[0].split("=", 1)[1].split(",") if glob]
        command = command[1:]
    if not command:
        print(
            "usage: staged.py [--changed-unless=<globs>] <command> [arguments...]", file=sys.stderr
        )
        return 2
    index = os.environ.get("GIT_INDEX_FILE")
    if not index:
        return subprocess.run(command, cwd=ROOT, check=False).returncode
    # git hands hooks a path relative to the worktree root, which is where moon runs repo tasks.
    return run_on_index(command, (ROOT / index).resolve(), ROOT, full_run)


if __name__ == "__main__":
    sys.exit(main())
