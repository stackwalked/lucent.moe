lucent_library(cs2-finders
    HEADERS include/lucent/cs2-finders/target.hpp
    SOURCES src/code.cpp src/entities.cpp src/target.cpp src/view.cpp
    DEPS lucent::cs2-modules lucent::finders lucent::kit lucent::pe lucent::probe
)
