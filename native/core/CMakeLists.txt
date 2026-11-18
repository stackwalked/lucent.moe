lucent_library(core
    HEADERS
        include/lucent/core/invariant.hpp
        include/lucent/core/narrow.hpp
        include/lucent/core/prelude.hpp
    SOURCES
        src/invariant.cpp
        src/toolchain_probe.cpp
)

lucent_test(core SOURCES tests/narrow_test.cpp)
