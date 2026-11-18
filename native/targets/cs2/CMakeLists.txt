# The dev entry point is compiled into dev builds only.
lucent_module(cs2
    SOURCES $<$<CONFIG:Debug>:src/dev_boot.cpp>
    DEPS lucent::kit
)
