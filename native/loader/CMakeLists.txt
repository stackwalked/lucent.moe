# The loader's parts, linked by the executable and by its tests: lucent_test() links
# lucent::<name>, and no helper makes a library whose headers stay private (tools/facts does the
# same).
add_library(
    lucent_loader_parts
    STATIC
    src/account/callback.cpp
    src/account/enrollment.cpp
    src/account/sign_in.cpp
    src/api/dpop.cpp
    src/api/server.cpp
    src/app/describe.cpp
    src/app/options.cpp
    src/app/run.cpp
    src/build/inputs.cpp
    src/cng/device_key.cpp
    src/cng/random.cpp
    src/cng/sha256.cpp
    src/http/client.cpp
    src/session/live_link.cpp
    src/session/relay.cpp
    src/start/game.cpp
    src/start/start_module.cpp
    src/store/saved_state.cpp
    src/text/base64url.cpp
    src/text/json.cpp
    src/update/decision.cpp
    src/update/install.cpp
)
add_library(lucent::loader ALIAS lucent_loader_parts)
target_include_directories(lucent_loader_parts PUBLIC src)
target_link_libraries(
    lucent_loader_parts
    PUBLIC
        lucent::core
        lucent::bundle
        lucent::crypto
        lucent::kit
        lucent::launch
        lucent::os
        lucent::pe
        lucent::wire
        bcrypt
        ncrypt
        winhttp
        crypt32
        ole32
        shell32
        ws2_32
)

# Read by src/build/inputs.cpp alone, so a new key, release or origin recompiles one file. A dev
# build talks to the dev server's loopback listeners (.config/dev.env, server:dev) and holds no
# release id; the code key is optional there (cmake/lucent.cmake).
set_property(
    SOURCE src/build/inputs.cpp
    APPEND
    PROPERTY
        COMPILE_DEFINITIONS
            "LUCENT_LOADER_CODE_PUBLIC_KEY=\"${LUCENT_CODE_PUBLIC_KEY}\""
            "LUCENT_LOADER_RELEASE_ID=\"$<$<CONFIG:Release>:${LUCENT_RELEASE_ID}>\""
            "LUCENT_LOADER_API_ORIGIN=\"$<IF:$<CONFIG:Release>,https://api.lucent.moe,http://127.0.0.1:4711>\""
            "LUCENT_LOADER_WEB_ORIGIN=\"$<IF:$<CONFIG:Release>,https://lucent.moe,http://localhost:4710>\""
)

lucent_executable(loader SOURCES src/main.cpp DEPS lucent::loader)
set_target_properties(lucent_loader PROPERTIES OUTPUT_NAME lucent-loader)

lucent_test(loader
    SOURCES
        tests/dpop_test.cpp
        tests/game_test.cpp
        tests/parsers_test.cpp
        tests/relay_test.cpp
        tests/update_test.cpp
)
