# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Counts the uses of kit's `raw` escape hatch from the access boundary.

`kit::raw` reaches foreign memory without a fact or a capability, and makes domain tokens outside
the lifecycle. Every use is spelled `raw::`, so grep finds it; this reports how many there are and
where, in product code and in tests apart. It gates nothing yet: a use is debt to promote into a
proper API, and the count is there so the debt is seen.
"""

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

NATIVE = "native/"
CPP_SUFFIXES = frozenset({".hpp", ".cpp", ".h", ".cc", ".inl"})
# Where the hatch is defined, not used.
DEFINITIONS = frozenset({"native/kit/include/lucent/kit/raw.hpp", "native/kit/src/raw.cpp"})
USE = re.compile(r"\braw::")
COMMENT = re.compile(r"^\s*//")


@dataclass(frozen=True)
class Count:
    path: str
    uses: int

    @property
    def is_test(self) -> bool:
        return "/tests/" in self.path


def uses_in(lines: list[str]) -> int:
    return sum(len(USE.findall(line)) for line in lines if not COMMENT.match(line))


def is_counted(path: str) -> bool:
    return path.startswith(NATIVE) and Path(path).suffix in CPP_SUFFIXES and path not in DEFINITIONS


def report(counts: list[Count]) -> list[str]:
    product = [count for count in counts if not count.is_test]
    tests = [count for count in counts if count.is_test]
    lines = [f"{count.path}: {count.uses}" for count in product if count.uses]
    in_product = sum(count.uses for count in product)
    in_tests = sum(count.uses for count in tests)
    lines.append(
        f"raw uses: {in_product} in product code, {in_tests} in tests (counted, not gated)"
    )
    return lines


def _candidate_files() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [name for name in listed.stdout.split("\0") if name and Path(name).is_file()]


def main() -> int:
    counts = [
        Count(name, uses_in(Path(name).read_text(encoding="utf-8").splitlines()))
        for name in _candidate_files()
        if is_counted(name)
    ]
    for line in report(counts):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
