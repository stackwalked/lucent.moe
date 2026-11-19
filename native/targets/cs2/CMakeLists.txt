# The overlay's states, the domains and the features are libraries of their own, so their tests
# link without the module.
add_subdirectory(overlay)
add_subdirectory(domains)
add_subdirectory(features)

# The dev entry point and the dev demo are compiled into dev builds only.
lucent_module(cs2
    SOURCES
        $<$<CONFIG:Debug>:src/dev_boot.cpp>
        $<$<CONFIG:Debug>:src/overlay/dev_demo.cpp>
        src/attach.cpp
        src/overlay/dxgi_present.cpp
        src/overlay/overlay.cpp
        src/overlay/present.cpp
        src/overlay/renderer_build.cpp
    DEPS
        lucent::cs2-domains
        lucent::cs2-features
        lucent::cs2-modules
        lucent::cs2-overlay
        lucent::d3d11
        lucent::draw
        lucent::foreign
        lucent::kit
        lucent::menu
        lucent::text
        lucent::ui
        d3d11
        dwrite
        $<$<CONFIG:Debug>:lucent::dev_public_key>
)
