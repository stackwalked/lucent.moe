lucent_library(core
    HEADERS
        include/lucent/core/contain.hpp
        include/lucent/core/fault.hpp
        include/lucent/core/invariant.hpp
        include/lucent/core/match.hpp
        include/lucent/core/narrow.hpp
        include/lucent/core/prelude.hpp
        include/lucent/core/result.hpp
        include/lucent/core/stdx/function_ref.hpp
        include/lucent/core/text.hpp
    SOURCES
        src/contain.cpp
        src/invariant.cpp
        src/result.cpp
        src/text.cpp
        src/toolchain_probe.cpp
)

lucent_test(core SOURCES tests/contain_test.cpp tests/narrow_test.cpp tests/text_test.cpp)
