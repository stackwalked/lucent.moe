lucent_executable(devkey
    SOURCES
        src/main.cpp
        src/cli/options.cpp
        src/key/header.cpp
        src/key/seed.cpp
        src/sign/dev_bundle.cpp
    DEPS lucent::bundle lucent::crypto lucent::kit lucent::os lucent::pe bcrypt
)

# lucent::dev_public_key: this machine's dev public key as <lucent/devkey/public_key.hpp>, in the
# build tree only. The step runs on every build, so a deleted seed is recreated and its key reaches
# the module; devkey rewrites the header only when the key changed, and the byproduct lets Ninja
# see when it didn't, so nothing else rebuilds.
set(devkey_generated "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(devkey_header "${devkey_generated}/lucent/devkey/public_key.hpp")
add_custom_target(
    lucent_devkey_header
    COMMAND lucent_devkey header "${devkey_header}"
    BYPRODUCTS "${devkey_header}"
    COMMENT "Emitting the dev public key"
    VERBATIM
)
add_library(lucent_dev_public_key INTERFACE)
add_library(lucent::dev_public_key ALIAS lucent_dev_public_key)
target_include_directories(lucent_dev_public_key INTERFACE "${devkey_generated}")
target_link_libraries(lucent_dev_public_key INTERFACE lucent::crypto)
add_dependencies(lucent_dev_public_key lucent_devkey_header)
