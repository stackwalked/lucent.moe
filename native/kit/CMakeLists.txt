# The dev channel and every other dev-only part of kit exist in the Debug configuration only. Its
# header is no part of any other configuration's header set, and refuses to compile there.
lucent_library(kit
    HEADERS
        include/lucent/kit/boot_info.hpp
        include/lucent/kit/capability.hpp
        include/lucent/kit/clock.hpp
        include/lucent/kit/dev_build.hpp
        $<$<CONFIG:Debug>:include/lucent/kit/dev_channel.hpp>
        include/lucent/kit/fact.hpp
        include/lucent/kit/fact_apply.hpp
        include/lucent/kit/fact_resolve.hpp
        include/lucent/kit/game_module.hpp
        include/lucent/kit/hook.hpp
        include/lucent/kit/lifecycle.hpp
        include/lucent/kit/read_access.hpp
        include/lucent/kit/session.hpp
        include/lucent/kit/session_message.hpp
        include/lucent/kit/write_access.hpp
    SOURCES
        src/capability_section.cpp
        src/clock.cpp
        $<$<CONFIG:Debug>:src/dev_channel.cpp>
        $<$<CONFIG:Debug>:src/dev_facts.cpp>
        src/fact_apply.cpp
        src/fact_resolve.cpp
        src/fact_section.cpp
        src/game_module.cpp
        src/hook.cpp
        src/lifecycle.cpp
        src/release.cpp
        src/session.cpp
        src/session_message.cpp
        src/time_date_stamp.cpp
    DEPS lucent::bundle lucent::crypto lucent::foreign lucent::os lucent::pe safetyhook::safetyhook
)
# Read by <lucent/kit/dev_build.hpp>: 1 in dev builds, 0 in every other.
target_compile_definitions(lucent_kit PUBLIC "LUCENT_KIT_DEV_BUILD=$<CONFIG:Debug>")

lucent_test(kit
    SOURCES
        tests/access_test.cpp
        tests/capability_test.cpp
        tests/clock_test.cpp
        tests/fact_apply_test.cpp
        tests/fact_resolve_test.cpp
        tests/fact_section_other.cpp
        tests/fact_section_test.cpp
        tests/hook_test.cpp
        tests/session_message_test.cpp
        tests/unmap_stub_test.cpp
)

# Proves the ban: a source using the dev channel, compiled as a release build compiles kit's users,
# must fail with the channel's own refusal. Built only by the test, and kept out of
# compile_commands.json so clang-tidy never meets a unit that can't compile.
add_library(
    lucent_kit_dev_channel_in_release
    OBJECT
    EXCLUDE_FROM_ALL
    tests/dev_channel_in_release.cpp
)
target_include_directories(lucent_kit_dev_channel_in_release PRIVATE include)
target_link_libraries(lucent_kit_dev_channel_in_release PRIVATE lucent::core)
target_compile_definitions(lucent_kit_dev_channel_in_release PRIVATE LUCENT_KIT_DEV_BUILD=0)
set_target_properties(lucent_kit_dev_channel_in_release PROPERTIES EXPORT_COMPILE_COMMANDS OFF)
add_test(
    NAME "kit: a release build that uses the dev channel fails to compile"
    COMMAND
        "${CMAKE_COMMAND}" --build "${CMAKE_BINARY_DIR}" --target lucent_kit_dev_channel_in_release
)
set_tests_properties(
    "kit: a release build that uses the dev channel fails to compile"
    PROPERTIES LABELS kit PASS_REGULAR_EXPRESSION "the dev channel is dev-only"
)
