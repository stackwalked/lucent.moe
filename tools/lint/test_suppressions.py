import pytest
from suppressions import scan


def messages(text: str) -> list[str]:
    return [finding.message for finding in scan(text.splitlines())]


@pytest.mark.parametrize(
    "text",
    [
        "int x; // NOLINT(bugprone-foo): the game owns this pointer",
        "// NOLINTNEXTLINE(bugprone-foo) -- layout fixed by the engine",
        "// the engine fixes this layout\n// NOLINTNEXTLINE(bugprone-foo)",
        "// NOLINTEND(bugprone-foo)",
        "import os  # noqa: F401 -- re-exported",
        "x = f()  # pyright: ignore[reportUnknownVariableType] -- untyped vendor API",
        "// biome-ignore lint/suspicious/noExplicitAny: wire payload before validation",
        "// biome-ignore-end lint/suspicious/noExplicitAny: closes the range",
        "// @ts-expect-error the generated types lag the schema",
        "-- hand-aligned lookup table\n-- stylua: ignore",
        "-- stylua: ignore-end",
        "# aligned with the vcpkg docs\n# gersemi: off",
        "# gersemi: on",
        '#pragma clang diagnostic ignored "-Wpadded" // mirrors the target layout',
        "// a foreign signature fixes this bool\n// ast-grep-ignore: no-bool-parameter",
    ],
)
def test_accepts_named_and_reasoned_suppressions(text: str) -> None:
    assert messages(text) == []


@pytest.mark.parametrize(
    "text",
    [
        "int x; // NOLINT",
        "import os  # noqa",
        "x = f()  # type: ignore",
        "// biome-ignore: whatever",
        "#pragma clang diagnostic ignored // whatever",
        "// whatever\n// ast-grep-ignore",
    ],
)
def test_rejects_suppressions_that_name_no_rule(text: str) -> None:
    assert "suppression names no rule" in messages(text)


@pytest.mark.parametrize(
    "text",
    [
        "int x; // NOLINT(bugprone-foo)",
        "import os  # noqa: F401",
        "x = f()  # pyright: ignore[reportAny]",
        "// @ts-expect-error",
        "local t = {} -- stylua: ignore",
        "# gersemi: off",
        "// clang-format off",
        '#pragma clang diagnostic ignored "-Wpadded"',
        "// ast-grep-ignore: no-bool-parameter",
    ],
)
def test_rejects_suppressions_without_a_reason(text: str) -> None:
    assert messages(text) == ["suppression gives no reason"]


def test_a_marker_above_is_not_a_reason_for_the_next() -> None:
    text = "// NOLINTNEXTLINE(bugprone-foo): reason\n// NOLINTNEXTLINE(bugprone-bar)"
    assert messages(text) == ["suppression gives no reason"]


def test_bans_ts_ignore_outright() -> None:
    assert messages("// @ts-ignore because") == ["use @ts-expect-error with a reason"]


@pytest.mark.parametrize("word", ["TODO", "FIXME", "HACK", "XXX"])
def test_bans_deferred_work_markers_in_code(word: str) -> None:
    assert messages(f"// {word}: later") == [
        "deferred work goes to the wishlist or issues, not the code"
    ]


def test_prose_may_name_deferred_work_markers() -> None:
    assert scan(["No `TODO` in code."], prose=True) == []
