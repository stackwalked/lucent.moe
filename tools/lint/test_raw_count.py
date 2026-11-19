from raw_count import Count, is_counted, report, uses_in


def test_counts_every_raw_use_on_a_line() -> None:
    lines = [
        "const auto token = kit::raw::token();",
        "kit::raw::access{source}.read(kit::raw::access{source}.read(p));",
    ]
    expected = 3
    assert uses_in(lines) == expected


def test_ignores_comments_and_lookalike_names() -> None:
    lines = [
        "// kit::raw::token() would do here, but doesn't",
        "const auto drawn = raw_bytes::size;",
        "const auto rawness = draw::color{};",
    ]
    assert uses_in(lines) == 0


def test_counts_native_sources_but_not_the_hatch_itself() -> None:
    assert is_counted("native/targets/cs2/domains/src/world.cpp")
    assert is_counted("native/kit/tests/access_test.cpp")
    assert not is_counted("native/kit/include/lucent/kit/raw.hpp")
    assert not is_counted("native/kit/src/raw.cpp")
    assert not is_counted("web/src/raw.ts")
    assert not is_counted("native/kit/moon.yml")


def test_reports_product_uses_by_file_and_tests_only_in_total() -> None:
    counts = [
        Count("native/targets/cs2/src/attach.cpp", 2),
        Count("native/targets/cs2/src/clean.cpp", 0),
        Count("native/kit/tests/access_test.cpp", 5),
    ]
    assert report(counts) == [
        "native/targets/cs2/src/attach.cpp: 2",
        "raw uses: 2 in product code, 5 in tests (counted, not gated)",
    ]
