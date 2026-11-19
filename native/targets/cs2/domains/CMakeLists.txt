lucent_library(cs2-domains
    HEADERS
        include/lucent/cs2-domains/foreign/entities.hpp
        include/lucent/cs2-domains/foreign/view.hpp
        include/lucent/cs2-domains/view.hpp
        include/lucent/cs2-domains/world.hpp
        include/lucent/cs2-domains/world_domain.hpp
    SOURCES
        src/view.cpp
        src/world.cpp
        src/world_domain.cpp
    DEPS lucent::cs2-modules lucent::draw lucent::foreign lucent::kit
)

lucent_test(cs2-domains SOURCES tests/world_test.cpp)
