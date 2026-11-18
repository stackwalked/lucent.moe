import pytest
from includes import Project, parse_depends_on, scan

PROJECTS = [
    Project("core", "native/core", frozenset()),
    Project("os", "native/libs/os", frozenset({"core"})),
    Project("pe", "native/libs/pe", frozenset({"core"})),
    Project("kit", "native/kit", frozenset({"core", "os", "pe"})),
    Project("testing", "native/testing", frozenset({"core"})),
]


def messages(path: str, text: str) -> list[str]:
    return [finding.message for finding in scan(path, text.splitlines(), PROJECTS)]


def test_reads_plain_and_object_dependencies_in_flow_and_block_form() -> None:
    both = {"core": "production", "os": "development"}
    flow = 'dependsOn: ["core", { id: "os", scope: "development" }]'
    block = "dependsOn:\n  - core\n  - id: os\n    scope: development\n"
    spread = 'dependsOn: [\n  "core",\n  { id: os, scope: development },\n]\n'
    assert parse_depends_on(flow) == both
    assert parse_depends_on(block) == both
    assert parse_depends_on(spread) == both
    plain = "dependsOn:\n  - 'pe'\n  - { id: os }\ntasks: {}\n"
    assert parse_depends_on(plain) == {"pe": "production", "os": "production"}
    assert parse_depends_on('language: "cpp"\n') == {}


def test_development_dependency_counts_from_tests_only() -> None:
    projects = [
        *PROJECTS,
        Project("probe", "native/libs/probe", frozenset({"core"}), frozenset({"os"})),
    ]
    text = ["#include <lucent/os/file.hpp>"]
    assert scan("native/libs/probe/tests/a_test.cpp", text, projects) == []
    found = scan("native/libs/probe/src/a.cpp", text, projects)
    assert [f.message for f in found] == [
        "<lucent/os/file.hpp> but os is a development dependency of probe: tests/ only"
    ]


def test_accepts_own_declared_and_implicit_core_includes() -> None:
    text = "#include <lucent/kit/hook.hpp>\n#include <lucent/os/file.hpp>\n"
    text += "#include <lucent/core/x.hpp>"
    assert messages("native/kit/src/hook.cpp", text) == []
    assert messages("native/libs/os/src/file.cpp", "#include <lucent/core/x.hpp>") == []


def test_rejects_undeclared_project() -> None:
    found = messages("native/libs/pe/src/a.cpp", "#include <lucent/os/file.hpp>")
    assert found == ["<lucent/os/file.hpp> but pe does not depend on os in moon.yml"]


def test_transitive_dependencies_do_not_count() -> None:
    projects = [
        Project("core", "native/core", frozenset()),
        Project("a", "native/a", frozenset({"core"})),
        Project("b", "native/b", frozenset({"a"})),
    ]
    findings = scan("native/b/src/x.cpp", ["#include <lucent/core/y.hpp>"], projects)
    assert findings == []
    projects.append(Project("c", "native/c", frozenset({"b"})))
    findings = scan("native/c/src/x.cpp", ["#include <lucent/a/y.hpp>"], projects)
    assert len(findings) == 1


def test_rejects_unknown_lucent_prefix() -> None:
    assert messages("native/kit/src/a.cpp", "#include <lucent/nothing/a.hpp>") == [
        "<lucent/nothing/a.hpp> names no native project"
    ]


def test_testing_header_only_from_tests() -> None:
    text = "#include <lucent/testing/host.hpp>"
    assert messages("native/libs/pe/tests/a_test.cpp", text) == []
    assert messages("native/libs/pe/src/a.cpp", text) == [
        "<lucent/testing/host.hpp> is for tests/ only"
    ]


def test_fuzz_header_only_from_fuzz() -> None:
    text = "#include <lucent/fuzzing/run_one.hpp>"
    assert messages("native/libs/pe/fuzz/imports.cpp", text) == []
    assert messages("native/libs/pe/tests/a_test.cpp", text) == [
        "<lucent/fuzzing/run_one.hpp> is for fuzz/ only"
    ]


def test_quoted_include_of_own_private_header_is_fine() -> None:
    assert messages("native/kit/src/a.cpp", '#include "release.hpp"') == []
    assert messages("native/kit/tests/a_test.cpp", '#include "../src/unmap_stub.hpp"') == []


def test_rejects_quoted_include_into_another_projects_src() -> None:
    found = messages("native/kit/src/a.cpp", '#include "../../libs/os/src/names.hpp"')
    assert found == ['"../../libs/os/src/names.hpp" reaches into the private src/ of os']


def test_public_header_never_includes_src() -> None:
    found = messages("native/kit/include/lucent/kit/a.hpp", '#include "../../../src/impl.hpp"')
    assert found == ['public header includes private "../../../src/impl.hpp"']
    assert messages("native/kit/include/lucent/kit/a.hpp", '#include "b.hpp"') == []


@pytest.mark.parametrize("header", ["Windows.h", "winternl.h", "NTSTATUS.H", "TlHelp32.h"])
def test_windows_headers_stay_out_of_public_headers(header: str) -> None:
    text = f"#include <{header}>"
    assert messages("native/libs/os/include/lucent/os/a.hpp", text) != []
    assert messages("native/libs/os/src/a.cpp", text) == []
    assert messages("native/libs/os/tests/a_test.cpp", text) == []


def test_intrin_is_not_a_windows_header() -> None:
    assert messages("native/core/include/lucent/core/a.hpp", "#include <intrin.h>") == []


def test_reports_line_numbers_and_skips_files_outside_projects() -> None:
    assert messages("native/cmake/a.hpp", "#include <windows.h>") == []
    findings = scan("native/core/include/lucent/core/a.hpp", ["", "#include <windows.h>"], PROJECTS)
    assert [f.line for f in findings] == [2]
