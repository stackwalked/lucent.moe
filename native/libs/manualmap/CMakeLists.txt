lucent_library(manualmap
    HEADERS include/lucent/manualmap/map.hpp
    SOURCES src/image_bytes.cpp src/imports.cpp src/map.cpp
    DEPS lucent::os lucent::pe
)

lucent_test(manualmap SOURCES tests/attach_test.cpp tests/stubs_test.cpp)
