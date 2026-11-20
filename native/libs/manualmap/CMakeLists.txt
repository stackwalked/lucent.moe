lucent_library(manualmap
    HEADERS include/lucent/manualmap/map.hpp
    SOURCES src/image_bytes.cpp src/imports.cpp src/map.cpp src/resolver.cpp
    DEPS lucent::os lucent::pe lucent::wire
)

lucent_test(manualmap
    SOURCES tests/attach_test.cpp tests/container_test.cpp tests/stubs_test.cpp
    DEPS lucent::wire
)

# The container test's image: a DLL whose attach proves contain() works once mapped, packed by
# the release build's own post-link tool into the container the test maps.
lucent_fixture(manualmap contained_probe SOURCES tests/fixtures/contained_probe.cpp)
target_link_libraries(lucent_manualmap_contained_probe_fixture PRIVATE lucent::core)

# An output of its own rather than a post-link step, so a changed pack repacks it too.
add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/contained_probe.container"
    COMMAND
        lucent_pack "$<TARGET_FILE:lucent_manualmap_contained_probe_fixture>"
        "${CMAKE_CURRENT_BINARY_DIR}/contained_probe.container" --release
        33333333333333333333333333333333
    DEPENDS lucent_manualmap_contained_probe_fixture lucent_pack
    VERBATIM
)
add_custom_target(
    lucent_manualmap_contained_probe_container
    DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/contained_probe.container"
)
add_dependencies(lucent_manualmap_tests lucent_manualmap_contained_probe_container)
target_compile_definitions(
    lucent_manualmap_tests
    PRIVATE
        "LUCENT_CONTAINED_PROBE_CONTAINER=\"${CMAKE_CURRENT_BINARY_DIR}/contained_probe.container\""
)
