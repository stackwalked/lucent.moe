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
    ],
)
def test_rejects_suppressions_without_a_reason(text: str) -> None:
    assert messages(text) == ["suppression gives no reason"]


def test_a_marker_above_is_not_a_reason_for_the_next() -> None:
    text = "// NOLINTNEXTLINE(bugprone-foo): reason\n// NOLINTNEXTLINE(bugprone-bar)"
    assert messages(text) == ["suppression gives no reason"]


def test_bans_ts_ignore_outright() -> None:
    assert messages("// @ts-ignore because") == ["use @ts-expect-error with a reason"]
