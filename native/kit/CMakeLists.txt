lucent_library(kit
    HEADERS
        include/lucent/kit/boot_info.hpp
        include/lucent/kit/hook.hpp
        include/lucent/kit/lifecycle.hpp
        include/lucent/kit/session.hpp
        include/lucent/kit/session_message.hpp
    SOURCES
        src/hook.cpp
        src/lifecycle.cpp
        src/release.cpp
        src/session.cpp
        src/session_message.cpp
    DEPS lucent::os lucent::pe safetyhook::safetyhook
)

lucent_test(kit
    SOURCES tests/hook_test.cpp tests/session_message_test.cpp tests/unmap_stub_test.cpp
)
