lucent_library(bundle
    HEADERS
        include/lucent/bundle/bundle.hpp
        include/lucent/bundle/fact_set.hpp
        include/lucent/bundle/release_manifest.hpp
    SOURCES src/bundle.cpp src/fact_set.cpp src/merkle.cpp src/release_manifest.cpp
    DEPS lucent::crypto
)

lucent_fuzz(bundle SOURCES fuzz/decode.cpp fuzz/release_manifest.cpp fuzz/verify.cpp)

lucent_test(bundle
    SOURCES
        tests/bundle_test.cpp
        tests/release_manifest_test.cpp
        tests/release_manifest_v2_test.cpp
        tests/release_manifest_v3_test.cpp
        tests/release_manifest_vectors_test.cpp
        tests/vectors_test.cpp
    DEPS lucent::os
)
target_compile_definitions(
    lucent_bundle_tests
    PRIVATE "LUCENT_CONTRACTS_DIR=\"${CMAKE_SOURCE_DIR}/../contracts\""
)
