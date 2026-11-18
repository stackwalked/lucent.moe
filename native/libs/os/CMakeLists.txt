lucent_library(os
    HEADERS
        include/lucent/os/address_range.hpp
        include/lucent/os/file.hpp
        include/lucent/os/frozen_threads.hpp
        include/lucent/os/modules.hpp
        include/lucent/os/pipe.hpp
        include/lucent/os/process.hpp
        include/lucent/os/remote_call.hpp
        include/lucent/os/remote_memory.hpp
        include/lucent/os/unique_handle.hpp
    SOURCES
        src/address_range.cpp
        src/file.cpp
        src/frozen_threads.cpp
        src/modules.cpp
        src/names.cpp
        src/pipe.cpp
        src/process.cpp
        src/remote_call.cpp
        src/remote_memory.cpp
        src/unique_handle.cpp
)

lucent_test(os SOURCES tests/frozen_threads_test.cpp)
