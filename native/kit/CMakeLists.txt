lucent_library(kit
    HEADERS
        include/lucent/kit/boot_info.hpp
        include/lucent/kit/lifecycle.hpp
        include/lucent/kit/session.hpp
        include/lucent/kit/session_message.hpp
    SOURCES
        src/lifecycle.cpp
        src/session.cpp
        src/session_message.cpp
    DEPS lucent::os
)

lucent_test(kit SOURCES tests/session_message_test.cpp)
