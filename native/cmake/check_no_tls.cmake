# Fails the build when a module we map has a TLS directory. The mapper gives an image no static TLS:
# the loader's TLS setup is internal to ntdll and changes with Windows builds, so an image that
# needs TLS would crash on its first access, on whichever thread got there first. Failing here names
# the module at build time instead.
#
# Thread-safe function-local statics pull TLS in (MSVC ABI: _Init_thread_epoch, _tls_index), as do
# thread_local and __declspec(thread). Our code bans all three; a dependency that trips this needs a
# decision, not a workaround.
#
# Usage: cmake -DREADOBJ=<llvm-readobj> -DMODULE=<module.dll> -P check_no_tls.cmake

execute_process(
    COMMAND "${READOBJ}" --file-headers "${MODULE}"
    OUTPUT_VARIABLE headers
    COMMAND_ERROR_IS_FATAL ANY
)
string(REGEX MATCH "TLSTableSize: 0x([0-9A-Fa-f]+)" found "${headers}")
if(NOT found)
    message(FATAL_ERROR "no TLS directory entry in llvm-readobj's output for ${MODULE}")
endif()
if(NOT CMAKE_MATCH_1 STREQUAL "0")
    message(
        FATAL_ERROR
        "${MODULE} has a TLS directory (size 0x${CMAKE_MATCH_1}). Mapped modules can't use static "
        "TLS: look for thread_local, __declspec(thread), or a thread-safe function-local static, "
        "including in dependencies."
    )
endif()
