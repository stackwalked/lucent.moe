lucent_library(foreign
    HEADERS
        include/lucent/foreign/foreign_ptr.hpp
        include/lucent/foreign/foreign_ptr32.hpp
        include/lucent/foreign/memory_source.hpp
    SOURCES
        src/memory_source.cpp
    DEPS lucent::os
)

lucent_test(foreign SOURCES tests/memory_source_test.cpp)
