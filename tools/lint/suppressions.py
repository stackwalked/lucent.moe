# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Every suppression names what it suppresses and says why.

The reason sits after the marker when the tool tolerates trailing text, otherwise
on the comment line directly above (StyLua and gersemi stop matching their marker
when anything follows it).

Deferred-work markers (TODO and friends) are banned in code: deferred work goes to
the wishlist or issues. Prose files may name them.
"""

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Marker:
    pattern: re.Pattern[str]
    needs_rules: bool
    banned: str | None = None
    in_prose: bool = True


def _marker(
    regex: str, *, needs_rules: bool = False, banned: str | None = None, in_prose: bool = True
) -> Marker:
    return Marker(re.compile(regex), needs_rules, banned, in_prose)


# Each pattern captures the named rules (if the syntax has them) and the text after.
# Closing markers (NOLINTEND, ignore-end, gersemi: on, clang-format on) carry no reason.
MARKERS = (
    _marker(r"NOLINT(?:NEXTLINE|BEGIN)?(?!END)(?P<rules>\([^)]*\))?(?P<rest>.*)", needs_rules=True),
    _marker(r"clang-format off(?P<rest>.*)"),
    _marker(
        r"#\s*noqa(?P<rules>:\s*[A-Z]+[0-9]+(?:[,\s]+[A-Z]+[0-9]+)*)?(?P<rest>.*)", needs_rules=True
    ),
    _marker(
        r"ruff:\s*noqa(?P<rules>:\s*[A-Z]+[0-9]+(?:[,\s]+[A-Z]+[0-9]+)*)?(?P<rest>.*)",
        needs_rules=True,
    ),
    _marker(r"(?:type|pyright):\s*ignore(?P<rules>\[[^\]]+\])?(?P<rest>.*)", needs_rules=True),
    _marker(
        r"biome-ignore(?:-all|-start)?(?!-end)(?P<rules>\s+[a-z]+/\S+?)?:?(?P<rest>.*)",
        needs_rules=True,
    ),
    _marker(r"@ts-expect-error(?P<rest>.*)"),
    _marker(r"@ts-(?:ignore|nocheck)", banned="use @ts-expect-error with a reason"),
    _marker(r"stylua:\s*ignore(?:-start)?(?!-end)(?P<rest>.*)"),
    _marker(r"gersemi:\s*off(?P<rest>.*)"),
    _marker(
        r"#\s*pragma\s+clang\s+diagnostic\s+ignored(?P<rules>\s+\"-W[^\"]+\")?(?P<rest>.*)",
        needs_rules=True,
    ),
    # ast-grep reads what follows the marker as rule ids, so the reason goes above.
    _marker(
        r"ast-grep-ignore(?P<rules>:\s*[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)?(?P<rest>)",
        needs_rules=True,
    ),
    _marker(
        r"\b(?:TODO|FIXME|HACK|XXX)\b",
        banned="deferred work goes to the wishlist or issues, not the code",
        in_prose=False,
    ),
)

# Prose may name the deferred-work markers, e.g. to state the rule above.
PROSE_SUFFIXES = frozenset({".md"})

COMMENT = re.compile(r"^\s*(?://|#|--|/\*|\*)\s*(?P<text>.*?)\s*(?:\*/)?$")
REASON_NOISE = " \t-:#*/"

# These files spell the markers out as data.
EXEMPT = frozenset(
    {"tools/lint/suppressions.py", "tools/lint/test_suppressions.py", "native/.clang-format"}
)


@dataclass(frozen=True)
class Finding:
    line: int
    message: str


def _comment_text(line: str) -> str:
    match = COMMENT.match(line)
    if match is None:
        return ""
    text = match.group("text")
    # A marker on the line above is not a reason for this one.
    if any(marker.pattern.search(text) for marker in MARKERS):
        return ""
    return text


def scan(lines: list[str], *, prose: bool = False) -> list[Finding]:
    findings: list[Finding] = []
    for index, line in enumerate(lines):
        for marker in MARKERS:
            if prose and not marker.in_prose:
                continue
            match = marker.pattern.search(line)
            if match is None:
                continue
            if marker.banned is not None:
                findings.append(Finding(index + 1, marker.banned))
                break
            groups = match.groupdict()
            if marker.needs_rules and not groups.get("rules"):
                findings.append(Finding(index + 1, "suppression names no rule"))
            inline = (groups.get("rest") or "").strip(REASON_NOISE)
            above = _comment_text(lines[index - 1]) if index > 0 else ""
            if not inline and not above:
                findings.append(Finding(index + 1, "suppression gives no reason"))
            break
    return findings


def _candidate_files() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [name for name in listed.stdout.split("\0") if name and name not in EXEMPT]


def main() -> int:
    failed = False
    for name in _candidate_files():
        path = Path(name)
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        for finding in scan(lines, prose=path.suffix in PROSE_SUFFIXES):
            print(f"{name}:{finding.line}: {finding.message}")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
