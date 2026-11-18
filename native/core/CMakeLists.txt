lucent_library(core
    HEADERS
        include/lucent/core/invariant.hpp
        include/lucent/core/match.hpp
        include/lucent/core/narrow.hpp
        include/lucent/core/prelude.hpp
        include/lucent/core/result.hpp
        include/lucent/core/text.hpp
    SOURCES
        src/invariant.cpp
        src/result.cpp
        src/text.cpp
        src/toolchain_probe.cpp
)

lucent_test(core SOURCES tests/narrow_test.cpp tests/text_test.cpp)
