lucent_library(crypto
    HEADERS include/lucent/crypto/crypto.hpp
    SOURCES src/crypto.cpp
    DEPS unofficial::monocypher::monocypher
)

lucent_test(crypto SOURCES tests/crypto_test.cpp)
