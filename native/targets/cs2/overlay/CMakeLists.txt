lucent_library(cs2-overlay
    HEADERS include/lucent/cs2-overlay/overlay_state.hpp
    SOURCES src/overlay_state.cpp
)

lucent_test(cs2-overlay SOURCES tests/overlay_state_test.cpp)
