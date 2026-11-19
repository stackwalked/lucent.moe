lucent_library(cs2-features
    HEADERS
        include/lucent/cs2-features/all.hpp
        include/lucent/cs2-features/player_box.hpp
    SOURCES
        src/all.cpp
        src/player_box.cpp
    DEPS lucent::cs2-domains lucent::draw lucent::kit
)

lucent_test(cs2-features SOURCES tests/player_box_test.cpp)
