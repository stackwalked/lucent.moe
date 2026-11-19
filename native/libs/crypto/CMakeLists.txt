lucent_library(crypto
    HEADERS include/lucent/crypto/crypto.hpp
    SOURCES src/crypto.cpp
    DEPS unofficial::monocypher::monocypher
)

lucent_test(crypto
    SOURCES tests/crypto_test.cpp tests/session_crypto_test.cpp tests/strict_vectors_test.cpp
    DEPS lucent::os
)
target_compile_definitions(
    lucent_crypto_tests
    PRIVATE "LUCENT_CONTRACTS_DIR=\"${CMAKE_SOURCE_DIR}/../contracts\""
)
