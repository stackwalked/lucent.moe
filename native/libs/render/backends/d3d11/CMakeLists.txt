lucent_library(d3d11
    HEADERS include/lucent/d3d11/renderer.hpp
    SOURCES
        src/build_attempts.cpp
        src/device_objects.cpp
        src/frame_pass.cpp
        src/image_slots.cpp
        src/pipeline_guard.cpp
        src/renderer.cpp
        src/scratch_pool.cpp
    DEPS lucent::draw
)

lucent_shaders(d3d11
    SHADERS
        quad_vs.hlsl:vs_5_0
        path_vs.hlsl:vs_5_0
        pass_vs.hlsl:vs_5_0
        main_ps.hlsl:ps_5_0
        blur_ps.hlsl:ps_5_0
        downsample_ps.hlsl:ps_5_0
        composite_ps.hlsl:ps_5_0
    INCLUDES "${CMAKE_CURRENT_SOURCE_DIR}/../../draw/include"
    DEPENDS
        src/shaders/constants.hlsli
        src/shaders/interface.hlsli
        ../../draw/include/lucent/draw/quad_record.hlsli
)

lucent_test(d3d11
    SOURCES
        tests/build_attempts_test.cpp
        tests/golden.cpp
        tests/golden_test.cpp
        tests/image_slots_test.cpp
        tests/renderer_golden_test.cpp
        tests/renderer_test.cpp
        tests/scratch_pool_test.cpp
    DEPS lucent::os
)
target_link_libraries(
    lucent_d3d11_tests
    PRIVATE d3d11 dxgi windowscodecs ole32 advapi32 ntdll
)
# The goldens are test inputs in the source tree; check_golden reads and, on request, rewrites them.
target_compile_definitions(
    lucent_d3d11_tests
    PRIVATE "LUCENT_GOLDENS_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/goldens\""
)
