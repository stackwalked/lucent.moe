lucent_library(cs2-features
    HEADERS
        include/lucent/cs2-features/all.hpp
        include/lucent/cs2-features/player_box.hpp
        include/lucent/cs2-features/quick_turn.hpp
        include/lucent/cs2-features/rapid_fire.hpp
    SOURCES
        src/all.cpp
        src/player_box.cpp
        src/quick_turn.cpp
        src/rapid_fire.cpp
    DEPS lucent::cs2-domains lucent::draw lucent::kit
)

lucent_test(cs2-features
    SOURCES tests/player_box_test.cpp tests/quick_turn_test.cpp tests/rapid_fire_test.cpp
)
