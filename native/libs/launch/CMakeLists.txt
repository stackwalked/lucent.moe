lucent_library(launch
    HEADERS
        include/lucent/launch/boot.hpp
        include/lucent/launch/channel.hpp
        include/lucent/launch/mapped_module.hpp
    SOURCES src/boot.cpp src/channel.cpp src/mapped_module.cpp
    DEPS lucent::kit lucent::manualmap lucent::os lucent::pe lucent::wire
)
