import subprocess
import sys
from typing import TYPE_CHECKING

from staged import run_on_index

if TYPE_CHECKING:
    from pathlib import Path

# In the snapshot: the staged content of tracked.txt, the staged new file, and nothing else.
SEES_ONLY_THE_INDEX = """
import pathlib, subprocess, sys
tree = pathlib.Path(".")
listed = subprocess.run(
    ["git", "ls-files", "--cached", "--others"], capture_output=True, text=True, check=True
)
ok = (
    (tree / "tracked.txt").read_text() == "staged"
    and (tree / "added.txt").read_text() == "new"
    and not (tree / "untracked.txt").exists()
    and sorted(listed.stdout.split()) == ["added.txt", "tracked.txt"]
)
sys.exit(0 if ok else 1)
"""


def _git(root: Path, *arguments: str) -> None:
    _ = subprocess.run(["git", *arguments], cwd=root, check=True, capture_output=True)


def _write(path: Path, text: str) -> None:
    _ = path.write_text(text)


def test_a_check_sees_the_staged_snapshot_not_the_working_tree(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    (tmp_path / ".moon" / "cache").mkdir(parents=True)
    _write(tmp_path / ".gitignore", ".moon/\n")
    _write(tmp_path / "tracked.txt", "committed")
    _git(tmp_path, "add", "tracked.txt")
    _git(tmp_path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
    _write(tmp_path / "tracked.txt", "staged")
    _write(tmp_path / "added.txt", "new")
    _git(tmp_path, "add", "tracked.txt", "added.txt")
    _write(tmp_path / "tracked.txt", "unstaged edit")
    _write(tmp_path / "untracked.txt", "another session's work")

    command = [sys.executable, "-c", SEES_ONLY_THE_INDEX]
    assert run_on_index(command, tmp_path / ".git" / "index", tmp_path) == 0
    assert (tmp_path / "tracked.txt").read_text() == "unstaged edit", (
        "the working tree is untouched"
    )
    assert list((tmp_path / ".moon" / "cache").iterdir()) == [], "the scratch tree is removed"
