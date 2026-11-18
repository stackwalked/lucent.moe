lucent_library(probe
    HEADERS include/lucent/probe/code_index.hpp include/lucent/probe/module_file.hpp
    SOURCES src/code_index.cpp src/module_file.cpp
    DEPS lucent::pe Zydis::Zydis
)

lucent_test(probe
    SOURCES tests/code_index_test.cpp tests/module_file_test.cpp tests/own_image.cpp
    DEPS lucent::os
)
