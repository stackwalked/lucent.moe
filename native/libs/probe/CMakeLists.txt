lucent_library(probe
    HEADERS
        include/lucent/probe/byte_pattern.hpp
        include/lucent/probe/code_index.hpp
        include/lucent/probe/module_file.hpp
        include/lucent/probe/navigation.hpp
        include/lucent/probe/rtti.hpp
        include/lucent/probe/strings.hpp
    SOURCES
        src/byte_pattern.cpp
        src/code_index.cpp
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
        tests/images.cpp
        tests/module_file_test.cpp
    DEPS lucent::os
)
lucent_fixture(probe game SOURCES tests/fixtures/game.cpp RTTI)
