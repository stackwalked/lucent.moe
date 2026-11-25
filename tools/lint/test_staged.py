import subprocess
import sys
from typing import TYPE_CHECKING

from staged import run_on_index

if TYPE_CHECKING:
    from pathlib import Path

    import pytest

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


# Prints the file arguments it was given, one per line.
ECHO_ARGUMENTS = "import sys; print('\\n'.join(sys.argv[1:]))"


def _repo_with_a_staged_change(root: Path, staged: dict[str, str]) -> None:
    _git(root, "init", "-q")
    (root / ".moon" / "cache").mkdir(parents=True)
    _write(root / ".gitignore", ".moon/\n")
    _write(root / "untouched.md", "committed")
    _write(root / "removed.md", "committed")
    _write(root / "rules.json", "{}")
    _git(root, "add", "untouched.md", "removed.md", "rules.json", ".gitignore")
    _git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
    for name, text in staged.items():
        _write(root / name, text)
        _git(root, "add", name)


def _arguments_seen(
    root: Path, full_run: list[str], capfd: pytest.CaptureFixture[str]
) -> list[str]:
    command = [sys.executable, "-c", ECHO_ARGUMENTS]
    assert run_on_index(command, root / ".git" / "index", root, full_run) == 0
    return sorted(capfd.readouterr().out.split())


def test_a_scoped_check_is_given_only_what_the_commit_adds_or_changes(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    _repo_with_a_staged_change(tmp_path, {"added.md": "new", "untouched.md": "committed"})
    _git(tmp_path, "rm", "-q", "removed.md")
    assert _arguments_seen(tmp_path, ["rules.json"], capfd) == ["added.md"]


def test_a_commit_that_changes_the_rules_is_checked_whole(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    _repo_with_a_staged_change(tmp_path, {"added.md": "new", "rules.json": '{"strict": true}'})
    assert _arguments_seen(tmp_path, ["rules.json"], capfd) == []


def test_a_commit_of_deletions_runs_nothing(tmp_path: Path) -> None:
    _repo_with_a_staged_change(tmp_path, {})
    _git(tmp_path, "rm", "-q", "removed.md")
    fails = [sys.executable, "-c", "import sys; sys.exit(3)"]
    assert run_on_index(fails, tmp_path / ".git" / "index", tmp_path, ["rules.json"]) == 0
