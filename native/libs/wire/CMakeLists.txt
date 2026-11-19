lucent_library(wire
    HEADERS
        include/lucent/wire/enrollment.hpp
        include/lucent/wire/frame.hpp
        include/lucent/wire/ids.hpp
        include/lucent/wire/lease.hpp
        include/lucent/wire/refusal.hpp
        include/lucent/wire/session.hpp
        include/lucent/wire/start.hpp
    SOURCES
        src/codec.cpp
        src/enrollment.cpp
        src/frame.cpp
        src/lease.cpp
        src/refusal.cpp
        src/session.cpp
        src/start.cpp
    DEPS lucent::bundle lucent::crypto
)

lucent_fuzz(wire SOURCES fuzz/decode.cpp)

lucent_test(wire
    SOURCES tests/wire_test.cpp tests/vectors_test.cpp
    DEPS lucent::os
)
target_compile_definitions(
    lucent_wire_tests
    PRIVATE "LUCENT_CONTRACTS_DIR=\"${CMAKE_SOURCE_DIR}/../contracts\""
)
