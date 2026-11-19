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

# The same module at each inlining an optimizer may choose for its registration code, built alike
# in every configuration. The reader finds the registrar list through the installer's loop as an
# optimizer emits it; unoptimized code spills every value through the stack.
# Debug's /Ob0 becomes clang's -fno-inline, which a later /Ob2 doesn't undo: /O2 alone left the
# Debug fixture with nothing inlined and the Release one with everything. -finline undoes it.
# found: cs2's client.dll (1.41.9.9) has schema_game's shape: InstallSchemaBindings calls a
# separate installer, and each registrar links itself in four inlined instructions.
foreach(
    variant
    IN
    ITEMS
        "schema_game;clang::noinline;clang::always_inline"
        # The registrars link through a helper.
        "schema_game_outlined;clang::noinline;clang::noinline"
        # The export walks the registrars itself.
        "schema_game_inlined;clang::always_inline;clang::always_inline"
)
    list(GET variant 0 fixture)
    list(GET variant 1 installer)
    list(GET variant 2 link)
    lucent_fixture(source2-probe ${fixture} SOURCES tests/fixtures/schema_game.cpp)
    set(target lucent_source2-probe_${fixture}_fixture)
    target_compile_options(${target} PRIVATE /O2 /clang:-finline)
    target_compile_definitions(
        ${target}
        PRIVATE SCHEMA_GAME_INSTALLER=${installer} SCHEMA_GAME_LINK=${link}
    )
    set_property(TARGET ${target} PROPERTY MSVC_RUNTIME_LIBRARY MultiThreaded)
endforeach()
