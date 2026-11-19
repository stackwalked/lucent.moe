lucent_executable(facts
    SOURCES
        src/main.cpp
        src/cache/binaries.cpp
        src/check/names.cpp
        src/cli/options.cpp
        src/generate/generate.cpp
        src/generate/kind_check.cpp
        src/generate/manifest.cpp
        src/install/steam.cpp
        src/targets/linked.cpp
    DEPS lucent::bundle lucent::crypto lucent::cs2-finders lucent::finder lucent::kit lucent::os lucent::pe lucent::probe bcrypt
)
