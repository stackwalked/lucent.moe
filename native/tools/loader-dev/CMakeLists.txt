lucent_executable(loader-dev
    SOURCES
        src/main.cpp
        src/cli/describe.cpp
        src/cli/options.cpp
        src/inject/boot.cpp
        src/inject/load.cpp
        src/inject/mapper.cpp
        src/inject/os_loader.cpp
        src/session/channel.cpp
        src/session/relay.cpp
    DEPS lucent::kit lucent::manualmap lucent::os lucent::pe
)
