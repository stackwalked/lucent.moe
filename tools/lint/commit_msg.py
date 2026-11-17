# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Commit messages are `<moon-project>[/<subpath>]: <what changed>`, with a body saying why."""

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import cast

SUBJECT = re.compile(r"^(?P<scope>[a-z0-9][a-z0-9-]*)(?:/[^\s:]+)?: (?P<what>\S.*)$")

# Subjects git writes itself, during merges and history edits.
GIT_GENERATED = ("Merge ", 'Revert "', "fixup! ", "squash! ", "amend! ")

# The tools/repo project's id; it covers changes outside every other project. Kept even if
# that project moves, since the commit format names it.
ROOT_SCOPE = "repo"


def _meaningful_lines(message: str) -> list[str]:
    lines: list[str] = []
    for line in message.splitlines():
        # Everything below the scissors line is the diff `git commit -v` shows.
        if line.startswith("# ------------------------ >8 ------------------------"):
            break
        if not line.startswith("#"):
            lines.append(line.rstrip())
    while lines and not lines[-1]:
        del lines[-1]
    return lines


def validate(message: str, scopes: frozenset[str]) -> list[str]:
    lines = _meaningful_lines(message)
    if not lines:
        return ["message is empty"]
    subject = lines[0]
    if subject.startswith(GIT_GENERATED):
        return []
    match = SUBJECT.match(subject)
    if match is None:
        return [f"subject must be `<project>[/<subpath>]: <what changed>`, got: {subject}"]
    errors: list[str] = []
    scope = match.group("scope")
    if scope not in scopes:
        known = ", ".join(sorted(scopes))
        errors.append(f"`{scope}` is not a moon project; known: {known}")
    if len(lines) < 3 or lines[1] or not any(lines[2:]):  # noqa: PLR2004 -- subject, blank, body
        errors.append("body must follow a blank line and say why")
    return errors


def _moon_scopes() -> frozenset[str]:
    queried = subprocess.run(
        ["moon", "query", "projects"],
        capture_output=True,
        text=True,
        check=True,
    )
    graph = cast("dict[str, list[dict[str, object]]]", json.loads(queried.stdout))
    ids = {str(project["id"]) for project in graph["projects"]}
    return frozenset({ROOT_SCOPE, *ids})


def main() -> int:
    if len(sys.argv) != 2:  # noqa: PLR2004 -- program name plus the message file git passes
        print("usage: commit_msg.py <message-file>", file=sys.stderr)
        return 2
    message = Path(sys.argv[1]).read_text(encoding="utf-8")
    errors = validate(message, _moon_scopes())
    for error in errors:
        print(f"commit-msg: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
