lucent_executable(pack
    SOURCES
        src/main.cpp
        src/cli/options.cpp
        src/image/convert.cpp
        src/image/raw_headers.cpp
        src/image/refusal.cpp
        src/image/system_modules.cpp
    DEPS lucent::build lucent::crypto lucent::kit lucent::os lucent::pe lucent::wire
)
