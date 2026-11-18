lucent_library(bundle
    HEADERS include/lucent/bundle/bundle.hpp include/lucent/bundle/fact_set.hpp
    SOURCES src/bundle.cpp src/fact_set.cpp src/merkle.cpp
    DEPS lucent::crypto
)

lucent_fuzz(bundle SOURCES fuzz/decode.cpp fuzz/verify.cpp)

lucent_test(bundle SOURCES tests/bundle_test.cpp tests/vectors_test.cpp DEPS lucent::os)
target_compile_definitions(
    lucent_bundle_tests
    PRIVATE "LUCENT_CONTRACTS_DIR=\"${CMAKE_SOURCE_DIR}/../contracts\""
)
