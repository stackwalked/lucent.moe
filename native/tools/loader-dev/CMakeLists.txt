lucent_executable(loader-dev
    SOURCES
        src/main.cpp
        src/cli/describe.cpp
        src/cli/options.cpp
        src/inject/load.cpp
        src/inject/os_loader.cpp
        src/session/relay.cpp
    DEPS lucent::kit lucent::launch lucent::os lucent::pe lucent::wire
)
