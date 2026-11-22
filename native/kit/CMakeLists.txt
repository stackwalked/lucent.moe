# The dev channel and every other dev-only part of kit exist in the Debug configuration only. Its
# header is no part of any other configuration's header set, and refuses to compile there.
lucent_library(kit
    HEADERS
        include/lucent/kit/bind.hpp
        include/lucent/kit/boot_info.hpp
        include/lucent/kit/canvas.hpp
        include/lucent/kit/capability.hpp
        include/lucent/kit/clock.hpp
        include/lucent/kit/config_store.hpp
        include/lucent/kit/context.hpp
        include/lucent/kit/core_capabilities.hpp
        include/lucent/kit/dev_build.hpp
        include/lucent/kit/domain_token.hpp
        include/lucent/kit/draw_context.hpp
        $<$<CONFIG:Debug>:include/lucent/kit/dev_channel.hpp>
        include/lucent/kit/fact.hpp
        include/lucent/kit/fact_apply.hpp
        include/lucent/kit/fact_resolve.hpp
        include/lucent/kit/feature.hpp
        include/lucent/kit/feature_section.hpp
        include/lucent/kit/game_module.hpp
        include/lucent/kit/handoff.hpp
        include/lucent/kit/hook.hpp
        include/lucent/kit/lifecycle.hpp
        include/lucent/kit/memory_storage.hpp
        include/lucent/kit/own_release.hpp
        include/lucent/kit/profile.hpp
        include/lucent/kit/profile_storage.hpp
        include/lucent/kit/published.hpp
        include/lucent/kit/raw.hpp
        include/lucent/kit/read_access.hpp
        include/lucent/kit/registry.hpp
        include/lucent/kit/session.hpp
        include/lucent/kit/session_message.hpp
        include/lucent/kit/settings.hpp
        include/lucent/kit/view_set.hpp
        include/lucent/kit/wiring.hpp
        include/lucent/kit/worker_set.hpp
        include/lucent/kit/write_access.hpp
    SOURCES
        src/capability_section.cpp
        src/clock.cpp
        src/config_store.cpp
        src/core_capabilities.cpp
        src/data_client.cpp
        $<$<CONFIG:Debug>:src/dev_channel.cpp>
        $<$<CONFIG:Debug>:src/dev_facts.cpp>
        $<$<CONFIG:Debug>:src/dev_features.cpp>
        $<$<CONFIG:Debug>:src/dev_workers.cpp>
        src/fact_apply.cpp
        src/fact_resolve.cpp
        src/fact_section.cpp
        src/feature_section.cpp
        src/frame_inbox.cpp
        src/game_module.cpp
        src/hook.cpp
        src/late_modules.cpp
        src/lease_client.cpp
        src/lease_worker.cpp
        src/lifecycle.cpp
        src/memory_storage.cpp
        src/own_lease_key.cpp
        src/own_release.cpp
        src/random.cpp
        src/raw.cpp
        src/registry.cpp
        src/release.cpp
        src/session.cpp
        src/session_end.cpp
        src/session_message.cpp
        src/time_date_stamp.cpp
        src/worker_set.cpp
    DEPS lucent::build lucent::bundle lucent::crypto lucent::draw lucent::foreign lucent::os lucent::pe lucent::wire safetyhook::safetyhook bcrypt
)
# Read by <lucent/kit/dev_build.hpp>: 1 in dev builds, 0 in every other.
target_compile_definitions(lucent_kit PUBLIC "LUCENT_KIT_DEV_BUILD=$<CONFIG:Debug>")
# Read by src/own_lease_key.cpp alone, so a new lease key recompiles one file.
set_property(
    SOURCE src/own_lease_key.cpp
    APPEND
    PROPERTY
        COMPILE_DEFINITIONS
            "LUCENT_KIT_LEASE_PUBLIC_KEY=\"$<$<CONFIG:Release>:${LUCENT_LEASE_PUBLIC_KEY}>\""
)
# Read by src/own_release.cpp alone, so a new release id recompiles one file.
set_property(
    SOURCE src/own_release.cpp
    APPEND
    PROPERTY
        COMPILE_DEFINITIONS "LUCENT_KIT_RELEASE_ID=\"$<$<CONFIG:Release>:${LUCENT_RELEASE_ID}>\""
)

lucent_test(kit
    SOURCES
        tests/access_test.cpp
        tests/capability_test.cpp
        tests/clock_test.cpp
        tests/config_store_test.cpp
        tests/context_test.cpp
        tests/core_capabilities_test.cpp
        tests/fact_apply_test.cpp
        tests/fact_resolve_test.cpp
        tests/fact_section_other.cpp
        tests/fact_section_test.cpp
        tests/feature_section_test.cpp
        tests/handoff_test.cpp
        tests/hook_test.cpp
        tests/late_modules_test.cpp
        tests/own_lease_key_test.cpp
        tests/lease_client_test.cpp
        tests/own_release_test.cpp
        tests/published_test.cpp
        tests/registry_test.cpp
        tests/session_end_test.cpp
        tests/session_message_test.cpp
        tests/settings_test.cpp
        tests/unmap_stub_test.cpp
        tests/worker_set_test.cpp
)
lucent_fixture(kit late SOURCES tests/fixtures/late.cpp)
target_compile_definitions(
    lucent_kit_tests
    PRIVATE
        "LUCENT_KIT_TEST_RELEASE_ID=\"$<$<CONFIG:Release>:${LUCENT_RELEASE_ID}>\""
        "LUCENT_KIT_TEST_LEASE_PUBLIC_KEY=\"$<$<CONFIG:Release>:${LUCENT_LEASE_PUBLIC_KEY}>\""
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
target_link_libraries(lucent_kit_dev_channel_in_release PRIVATE lucent::core lucent::build)
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

# Proves the context's refusal: a feature naming a part it never declared fails to compile, with the
# concept that says so. Built only by the test, and kept out of compile_commands.json as above.
add_library(lucent_kit_context_undeclared OBJECT EXCLUDE_FROM_ALL tests/context_undeclared.cpp)
target_include_directories(lucent_kit_context_undeclared PRIVATE include)
target_link_libraries(lucent_kit_context_undeclared PRIVATE lucent::core lucent::build lucent::draw)
target_compile_definitions(lucent_kit_context_undeclared PRIVATE LUCENT_KIT_DEV_BUILD=1)
set_target_properties(lucent_kit_context_undeclared PROPERTIES EXPORT_COMPILE_COMMANDS OFF)
add_test(
    NAME "kit: a feature that uses a part it didn't declare fails to compile"
    COMMAND "${CMAKE_COMMAND}" --build "${CMAKE_BINARY_DIR}" --target lucent_kit_context_undeclared
)
set_tests_properties(
    "kit: a feature that uses a part it didn't declare fails to compile"
    PROPERTIES
        LABELS kit
        PASS_REGULAR_EXPRESSION
            "because 'needed_by<[^']*clock_view, [^']*tracker>' evaluated to false"
)

# Proves the access boundary: a feature that opens access to foreign memory itself, rather than
# taking a domain's views, fails to compile with the boundary's own refusal. Built only by the test,
# and kept out of compile_commands.json as above.
add_library(lucent_kit_feature_opens_access OBJECT EXCLUDE_FROM_ALL tests/feature_opens_access.cpp)
target_include_directories(lucent_kit_feature_opens_access PRIVATE include)
target_link_libraries(
    lucent_kit_feature_opens_access
    PRIVATE lucent::core lucent::build lucent::draw lucent::foreign
)
target_compile_definitions(lucent_kit_feature_opens_access PRIVATE LUCENT_KIT_DEV_BUILD=1)
set_target_properties(lucent_kit_feature_opens_access PROPERTIES EXPORT_COMPILE_COMMANDS OFF)
add_test(
    NAME "kit: a feature that opens foreign access itself fails to compile"
    COMMAND
        "${CMAKE_COMMAND}" --build "${CMAKE_BINARY_DIR}" --target lucent_kit_feature_opens_access
)
set_tests_properties(
    "kit: a feature that opens foreign access itself fails to compile"
    PROPERTIES
        LABELS kit
        PASS_REGULAR_EXPRESSION
            "features get views and stage tokens; a domain opens access with its domain_token"
)
