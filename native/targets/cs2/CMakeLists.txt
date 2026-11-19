# The dev entry point is compiled into dev builds only.
lucent_module(cs2
    SOURCES
        $<$<CONFIG:Debug>:src/dev_boot.cpp>
        src/attach.cpp
        src/overlay/dxgi_present.cpp
        src/overlay/present.cpp
    DEPS lucent::kit d3d11 $<$<CONFIG:Debug>:lucent::dev_public_key>
)
