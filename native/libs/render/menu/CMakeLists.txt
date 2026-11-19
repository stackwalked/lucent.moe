lucent_library(menu
    HEADERS
        include/lucent/menu/catalog.hpp
        include/lucent/menu/page.hpp
        include/lucent/menu/settings_menu.hpp
        include/lucent/menu/table_catalog.hpp
        include/lucent/menu/text_key.hpp
    SOURCES
        src/catalog.cpp
        src/page.cpp
        src/settings_menu.cpp
        src/table_catalog.cpp
        src/text_key.cpp
    DEPS lucent::draw lucent::kit lucent::text lucent::ui
)

lucent_test(menu
    SOURCES
        tests/catalog_test.cpp
        tests/page_test.cpp
    DEPS lucent::os
)
# ui's test driver and the text library's fixture font: the menu is tested on the same frames,
# clock and font as the widgets it is made of.
target_include_directories(lucent_menu_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../ui/tests")
target_compile_definitions(
    lucent_menu_tests
    PRIVATE "LUCENT_UI_FIXTURES_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/../text/tests/fixtures\""
)
