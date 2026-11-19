lucent_library(cs2-overlay
    HEADERS
        include/lucent/cs2-overlay/input_collector.hpp
        include/lucent/cs2-overlay/input_feed.hpp
        include/lucent/cs2-overlay/overlay_state.hpp
        include/lucent/cs2-overlay/window_input.hpp
    SOURCES
        src/input_collector.cpp
        src/input_feed.cpp
        src/overlay_state.cpp
        src/window_input.cpp
    DEPS lucent::draw lucent::kit lucent::ui
)

lucent_test(cs2-overlay
    SOURCES
        tests/input_collector_test.cpp
        tests/overlay_state_test.cpp
        tests/window_input_test.cpp
)
