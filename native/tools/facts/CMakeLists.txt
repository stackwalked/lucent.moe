# The generator's parts, linked by the executable and by its tests: lucent_test() links
# lucent::<name>, and the name lucent_facts is the executable's, which lucent_module()'s release
# check runs. Declared by hand because no helper makes a library whose headers stay private.
add_library(
    lucent_facts_parts
    STATIC
    src/cache/binaries.cpp
    src/check/names.cpp
    src/cli/options.cpp
    src/generate/changes.cpp
    src/generate/generate.cpp
    src/generate/kind_check.cpp
    src/generate/manifest.cpp
    src/install/steam.cpp
    src/latency/step_log.cpp
    src/targets/linked.cpp
    src/targets/named_modules.cpp
)
add_library(lucent::facts ALIAS lucent_facts_parts)
target_include_directories(lucent_facts_parts PUBLIC src)
target_link_libraries(
    lucent_facts_parts
    PUBLIC
        lucent::core
        lucent::bundle
        lucent::crypto
        lucent::cs2-finders
        lucent::finder
        lucent::kit
        lucent::os
        lucent::pe
        lucent::probe
        bcrypt
)

lucent_executable(facts SOURCES src/main.cpp DEPS lucent::facts)

lucent_test(facts
    SOURCES
        tests/binaries_test.cpp
        tests/changes_test.cpp
        tests/named_modules_test.cpp
        tests/scratch_directory.cpp
        tests/step_log_test.cpp
)
