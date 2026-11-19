lucent_library(source2-probe
    HEADERS
        include/lucent/source2-probe/module_schema.hpp
        include/lucent/source2-probe/schema.hpp
    SOURCES
        src/machine.cpp
        src/module_schema.cpp
        src/schema.cpp
    DEPS lucent::pe lucent::probe Zydis::Zydis
)

lucent_test(source2-probe SOURCES tests/schema_test.cpp DEPS lucent::os)
lucent_fixture(source2-probe schema_game SOURCES tests/fixtures/schema_game.cpp)
# Optimized, as the game ships: the reader finds the registrar list through the installer's loop as
# an optimizer emits it, and unoptimized code spills every value through the stack.
target_compile_options(lucent_source2-probe_schema_game_fixture PRIVATE /O2)
