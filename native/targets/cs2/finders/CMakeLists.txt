lucent_library(cs2-finders
    HEADERS include/lucent/cs2-finders/target.hpp
    SOURCES
        src/classes.cpp
        src/code.cpp
        src/command.cpp
        src/entities.cpp
        src/input.cpp
        src/schema_fields.cpp
        src/target.cpp
        src/view.cpp
    DEPS lucent::cs2-modules lucent::finder lucent::kit lucent::pe lucent::probe lucent::source2-probe
)
