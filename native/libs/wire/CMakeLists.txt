lucent_library(wire
    HEADERS
        include/lucent/wire/container.hpp
        include/lucent/wire/container_stream.hpp
        include/lucent/wire/enrollment.hpp
        include/lucent/wire/frame.hpp
        include/lucent/wire/ids.hpp
        include/lucent/wire/lease.hpp
        include/lucent/wire/refusal.hpp
        include/lucent/wire/release_seal.hpp
        include/lucent/wire/session.hpp
        include/lucent/wire/start.hpp
    SOURCES
        src/codec.cpp
        src/container.cpp
        src/container_stream.cpp
        src/enrollment.cpp
        src/frame.cpp
        src/lease.cpp
        src/refusal.cpp
        src/release_seal.cpp
        src/session.cpp
        src/start.cpp
    DEPS lucent::bundle lucent::crypto lz4::lz4
)

lucent_fuzz(wire SOURCES fuzz/container.cpp fuzz/decode.cpp)

lucent_test(wire
    SOURCES
        tests/container_test.cpp
        tests/container_vectors_test.cpp
        tests/vectors_test.cpp
        tests/wire_test.cpp
    DEPS lucent::os
)
target_compile_definitions(
    lucent_wire_tests
    PRIVATE "LUCENT_CONTRACTS_DIR=\"${CMAKE_SOURCE_DIR}/../contracts\""
)
