lucent_executable(devkey
    SOURCES
        src/main.cpp
        src/cli/options.cpp
        src/key/header.cpp
        src/key/release_check.cpp
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

# The release guard: a module outside the Debug configuration that links the dev key refuses to
# link, with this symbol's name as lld-link's "undefined symbol" error. A release trusts only the
# production fact keys; the dev key would accept every bundle any dev machine signs. Tools may link
# it in any configuration. The key copied into a module some other way is caught after the link
# (`devkey check`, lucent_module()).
target_link_options(
    lucent_dev_public_key
    INTERFACE
        "$<$<AND:$<NOT:$<CONFIG:Debug>>,$<STREQUAL:$<TARGET_PROPERTY:TYPE>,MODULE_LIBRARY>>:/INCLUDE:lucent_release_module_trusts_the_dev_public_key>"
)
add_dependencies(lucent_generated lucent_devkey_header)
