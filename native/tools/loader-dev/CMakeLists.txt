lucent_executable(loader-dev
    SOURCES src/channel.cpp src/inject.cpp src/main.cpp
    DEPS lucent::kit lucent::os lucent::pe
)
