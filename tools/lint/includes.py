# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""C++ include layering under native/.

A native project is a directory holding a moon.yml; its name is the directory name, which is
also the `lucent/<name>/` include prefix (lucent_library(<name>) puts public headers there).

1. `#include <lucent/X/...>` needs X to be the file's own project, one of its direct moon
   `dependsOn` entries, or core (lucent.cmake links core into every target). Transitive
   dependencies do not count: a project that includes a header declares the dependency.
   A dependency of moon scope `development` (`{ id: os, scope: development }`) counts from
   `tests/` only; every other scope counts everywhere.
   `lucent/testing/` is allowed from `tests/` only, and `lucent/fuzz/` (the libFuzzer entry in
   native/cmake/fuzz, which no project owns) from `fuzz/` only.
2. Private headers stay private: a quoted include never reaches into another project's
   `src/`, and a public header (under `include/`) never includes anything under a `src/`.
3. Win32/SDK headers (WIN32_HEADERS below) appear only in `src/` and `tests/`, never in a
   public header. `intrin.h` is compiler-provided and not on the list.
"""

import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

NATIVE = "native"
IMPLICIT_DEPS = frozenset({"core"})
TEST_ONLY = frozenset({"testing"})
FUZZ_ONLY = frozenset({"fuzz"})
DEFAULT_SCOPE = "production"
TEST_SCOPE = "development"

# Compared case-insensitively.
WIN32_HEADERS = frozenset(
    {
        "windows.h",
        "winnt.h",
        "winternl.h",
        "ntstatus.h",
        "ntdef.h",
        "winbase.h",
        "winsock2.h",
        "ws2tcpip.h",
        "tlhelp32.h",
        "psapi.h",
        "dbghelp.h",
        "winioctl.h",
        "shellapi.h",
        "excpt.h",
    }
)

INCLUDE = re.compile(r'^\s*#\s*include\s*(?P<open>[<"])(?P<target>[^>"]+)[>"]')
LUCENT_PREFIX = "lucent/"


@dataclass(frozen=True)
class Project:
    name: str
    root: str
    deps: frozenset[str]
    dev_deps: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Finding:
    line: int
    message: str


def _split_items(region: str) -> list[str]:
    items: list[str] = []
    depth = 0
    current = ""
    for char in region:
        if char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        if char == "," and depth == 1:
            items.append(current)
            current = ""
        else:
            current += char
    items.append(current)
    return items


def _entry(item: str) -> tuple[str, str] | None:
    identifier = re.search(r"\bid:\s*[\"']?(?P<id>[\w.-]+)", item)
    if identifier is not None:
        scope = re.search(r"\bscope:\s*[\"']?(?P<scope>\w+)", item)
        return identifier.group("id"), scope.group("scope") if scope else DEFAULT_SCOPE
    plain = re.fullmatch(r"[\s\[\]]*[\"']?(?P<id>[\w.-]+)[\"']?[\s\[\]]*", item)
    return (plain.group("id"), DEFAULT_SCOPE) if plain else None


def parse_depends_on(text: str) -> dict[str, str]:
    """Read `dependsOn` as id -> scope: plain ids or `{id, scope}` objects, flow or block."""
    lines = [line.split("#")[0].rstrip() for line in text.splitlines()]
    for index, line in enumerate(lines):
        match = re.match(r"^dependsOn:\s*(?P<rest>.*)$", line)
        if match is None:
            continue
        rest = match.group("rest").strip()
        items: list[str]
        if rest.startswith("["):
            region = rest
            following = iter(lines[index + 1 :])
            while region.count("[") > region.count("]"):
                region += next(following, "]")
            items = _split_items(region)
        else:
            items = []
            for item in lines[index + 1 :]:
                if item.lstrip().startswith("- "):
                    items.append(item.lstrip()[2:])
                elif item.startswith((" ", "	")) and items:
                    items[-1] += " " + item.strip()
                else:
                    break
        entries = (_entry(item) for item in items)
        return dict(entry for entry in entries if entry is not None)
    return {}


def project_of(path: str, projects: list[Project]) -> Project | None:
    owners = [p for p in projects if path.startswith(p.root + "/")]
    return max(owners, key=lambda p: len(p.root), default=None)


def _area(path: str, project: Project) -> str:
    relative = path.removeprefix(project.root + "/")
    first = relative.split("/", 1)[0]
    return first if first in {"include", "src", "tests", "fuzz"} else "other"


def _check_lucent(target: str, project: Project, area: str, projects: list[Project]) -> str | None:
    owner = target.removeprefix(LUCENT_PREFIX).split("/", 1)[0]
    if owner == project.name or owner in IMPLICIT_DEPS or owner in project.deps:
        return None
    if owner in FUZZ_ONLY:
        return None if area == "fuzz" else f"<{target}> is for fuzz/ only"
    if owner not in {p.name for p in projects}:
        return f"<{target}> names no native project"
    if owner in TEST_ONLY:
        return None if area == "tests" else f"<{target}> is for tests/ only"
    if owner in project.dev_deps:
        message = (
            f"<{target}> but {owner} is a development dependency of {project.name}: tests/ only"
        )
        return None if area == "tests" else message
    return f"<{target}> but {project.name} does not depend on {owner} in moon.yml"


def _check_quoted(
    path: str, target: str, project: Project, area: str, projects: list[Project]
) -> str | None:
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    reached = project_of(resolved, projects)
    if reached is not None and reached is not project and _area(resolved, reached) == "src":
        return f'"{target}" reaches into the private src/ of {reached.name}'
    if area == "include" and "src" in resolved.split("/"):
        return f'public header includes private "{target}"'
    return None


def scan(path: str, lines: list[str], projects: list[Project]) -> list[Finding]:
    project = project_of(path, projects)
    if project is None:
        return []
    area = _area(path, project)
    findings: list[Finding] = []
    for index, line in enumerate(lines):
        match = INCLUDE.match(line)
        if match is None:
            continue
        target = match.group("target")
        message = None
        if match.group("open") == '"':
            message = _check_quoted(path, target, project, area, projects)
        elif target.startswith(LUCENT_PREFIX):
            message = _check_lucent(target, project, area, projects)
        elif posixpath.basename(target).lower() in WIN32_HEADERS and area not in {"src", "tests"}:
            message = f"<{target}> is a Windows header; only src/ and tests/ may include it"
        if message is not None:
            findings.append(Finding(index + 1, message))
    return findings


def load_projects(files: list[str]) -> list[Project]:
    projects: list[Project] = []
    for name in files:
        if not name.startswith(NATIVE + "/") or posixpath.basename(name) != "moon.yml":
            continue
        root = posixpath.dirname(name)
        if root == NATIVE:
            continue
        deps = parse_depends_on(Path(name).read_text(encoding="utf-8"))
        production = frozenset(i for i, scope in deps.items() if scope != TEST_SCOPE)
        development = frozenset(i for i, scope in deps.items() if scope == TEST_SCOPE)
        projects.append(Project(posixpath.basename(root), root, production, development))
    return projects


def _candidate_files() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [name for name in listed.stdout.split("\0") if name and Path(name).is_file()]


CPP_SUFFIXES = frozenset({".hpp", ".cpp", ".h", ".cc", ".inl"})


def main() -> int:
    files = _candidate_files()
    projects = load_projects(files)
    failed = False
    for name in files:
        if not name.startswith(NATIVE + "/") or Path(name).suffix not in CPP_SUFFIXES:
            continue
        lines = Path(name).read_text(encoding="utf-8").splitlines()
        for finding in scan(name, lines, projects):
            print(f"{name}:{finding.line}: {finding.message}")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
