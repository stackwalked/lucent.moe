lucent_library(probe
    HEADERS
        include/lucent/probe/byte_pattern.hpp
        include/lucent/probe/code_index.hpp
        include/lucent/probe/finder.hpp
        include/lucent/probe/finding.hpp
        include/lucent/probe/instruction_pattern.hpp
        include/lucent/probe/module_file.hpp
        include/lucent/probe/navigation.hpp
        include/lucent/probe/rtti.hpp
        include/lucent/probe/strings.hpp
    SOURCES
        src/byte_pattern.cpp
        src/code_index.cpp
        src/decoder.cpp
        src/finder.cpp
        src/finding.cpp
        src/instruction_pattern.cpp
        src/module_file.cpp
        src/navigation.cpp
        src/ranges.cpp
        src/rtti.cpp
        src/strings.cpp
    DEPS lucent::pe Zydis::Zydis
)

lucent_test(probe
    SOURCES
        tests/anchors_test.cpp
        tests/code_index_test.cpp
        tests/finder_test.cpp
        tests/images.cpp
        tests/module_file_test.cpp
        tests/pattern_test.cpp
    DEPS lucent::os
)
lucent_fixture(probe game SOURCES tests/fixtures/game.cpp RTTI)
# A release link folds identical functions (lld's default /OPT:ICF without /DEBUG), merging the
# fixture's twin accessors into one export the tests expect to find twice.
target_link_options(lucent_probe_game_fixture PRIVATE /OPT:NOICF)
