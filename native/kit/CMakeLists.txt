lucent_library(kit
    HEADERS
        include/lucent/kit/boot_info.hpp
        include/lucent/kit/lifecycle.hpp
        include/lucent/kit/session.hpp
        include/lucent/kit/session_message.hpp
        include/lucent/kit/unique_handle.hpp
    SOURCES
        src/lifecycle.cpp
        src/session.cpp
        src/session_message.cpp
        src/unique_handle.cpp
)

lucent_test(kit SOURCES tests/session_message_test.cpp)
