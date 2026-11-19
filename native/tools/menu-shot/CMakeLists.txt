lucent_executable(menu-shot
    SOURCES src/main.cpp
    DEPS
        lucent::cs2-features
        lucent::cs2-overlay
        lucent::kit
        lucent::menu
        lucent::text
        lucent::ui
        lucent_offscreen
)
