lucent_library(ui
    HEADERS
        include/lucent/ui/box_style.hpp
        include/lucent/ui/button.hpp
        include/lucent/ui/context.hpp
        include/lucent/ui/dropdown.hpp
        include/lucent/ui/element_id.hpp
        include/lucent/ui/input_snapshot.hpp
        include/lucent/ui/interaction.hpp
        include/lucent/ui/label.hpp
        include/lucent/ui/motion.hpp
        include/lucent/ui/slider.hpp
        include/lucent/ui/text_spec.hpp
        include/lucent/ui/theme.hpp
        include/lucent/ui/toggle.hpp
    SOURCES
        src/button.cpp
        src/context.cpp
        src/dropdown.cpp
        src/input_snapshot.cpp
        src/label.cpp
        src/layout.cpp
        src/motion.cpp
        src/record.cpp
        src/slider.cpp
        src/theme.cpp
        src/toggle.cpp
    DEPS lucent::draw lucent::text
)

lucent_test(ui
    SOURCES
        tests/interaction_test.cpp
        tests/layout_test.cpp
        tests/motion_test.cpp
        tests/roots_test.cpp
        tests/scroll_test.cpp
        tests/widgets_test.cpp
    DEPS lucent::os
)
# The text library's fixture font: one test font for the render stack, never a system font.
target_compile_definitions(
    lucent_ui_tests
    PRIVATE "LUCENT_UI_FIXTURES_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/../text/tests/fixtures\""
)
