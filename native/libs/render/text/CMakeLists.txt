lucent_library(text
    HEADERS
        include/lucent/text/glyph_atlas.hpp
        include/lucent/text/text_layout.hpp
        include/lucent/text/text_system.hpp
    SOURCES
        src/fast_layout.cpp
        src/glyph_atlas.cpp
        src/glyph_collector.cpp
        src/latin_shaping.cpp
        src/raster.cpp
        src/shaped_layout.cpp
        src/text_engine.cpp
        src/text_system.cpp
    DEPS lucent::draw
)
target_link_libraries(lucent_text PRIVATE dwrite)

lucent_test(text
    SOURCES
        tests/draw_test.cpp
        tests/glyph_atlas_test.cpp
        tests/layout_test.cpp
    DEPS lucent::os
)
# The fixture fonts are test inputs in the source tree.
target_compile_definitions(
    lucent_text_tests
    PRIVATE "LUCENT_TEXT_FIXTURES_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures\""
)
