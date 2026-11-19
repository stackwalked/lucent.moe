#include "generate/changes.hpp"

#include <optional>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>

namespace lucent::facts {

TEST_CASE("a value that moved between sets is a change from the old value to the new") {
    const change_report report = changes_between({
        .before = "# facts: client.dll TimeDateStamp 0x6afe3e44 SizeOfImage 0x298d000\n"
                  "entity_system=0x253d760\n"
                  "view_matrix=0x255ce50\n",
        .after = "# facts: client.dll TimeDateStamp 0x6b000000 SizeOfImage 0x298e000\n"
                 "entity_system=0x253d760\n"
                 "view_matrix=0x255d000\n",
    });

    CHECK(
        report.changes
        == std::vector<fact_change>{
            {.fact = "view_matrix", .before = "0x255ce50", .after = "0x255d000"},
        }
    );
    CHECK(report.unchanged == 1);
}

TEST_CASE("a fact that newly resolves is added, and one that stopped resolving is removed") {
    const change_report report = changes_between({
        .before = "gone=0x10\nkept=0x20\n",
        .after = "kept=0x20\nfresh=0x30\n",
    });

    CHECK(
        report.changes
        == std::vector<fact_change>{
            {.fact = "fresh", .before = std::nullopt, .after = "0x30"},
            {.fact = "gone", .before = "0x10", .after = std::nullopt},
        }
    );
    CHECK(report.unchanged == 1);
}

TEST_CASE("comments, blank lines and CRLF line ends don't count as changes") {
    const change_report report = changes_between({
        .before = "# one build\r\n\r\nkept=0x20\r\n",
        .after = "# another build\nkept=0x20\n",
    });

    CHECK(report.changes.empty());
    CHECK(report.unchanged == 1);
}

TEST_CASE("the change report names every change and counts the rest") {
    const std::string text = describe(changes_between({
        .before = "a=0x1\nb=0x2\nc=0x3\n",
        .after = "a=0x1\nb=0x4\nd=0x5\n",
    }));

    CHECK(text.contains("changed  b"));
    CHECK(text.contains("0x2 -> 0x4"));
    CHECK(text.contains("added    d"));
    CHECK(text.contains("removed  c"));
    CHECK(text.ends_with("  1 unchanged\n"));
}

}
