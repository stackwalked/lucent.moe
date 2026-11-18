# Every native target is declared through these helpers, which own all flags. Flags are set for the
# whole tree rather than per target so the header-verification translation units CMake generates
# get them too; dependencies come prebuilt from vcpkg and never see them.

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT Embedded)
# Headers only (wishlist: modules get a lab spike first). Left on, CMake 4.5 scans every C++26
# target and builds `import std` from the STL's std.ixx.
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
set(CMAKE_CXX_MODULE_STD OFF)

add_compile_options(
    -Weverything
    -Werror
    # Which standard the code needs is the preset's choice, not a compatibility concern.
    -Wno-c++98-compat
    -Wno-c++98-compat-pedantic
    # Padding matters only for layout mirrors, which static_assert their size and offsets.
    -Wno-padded
    # The dialect forbids `default` in switches over our enums so -Wswitch flags new enumerators.
    -Wno-switch-default
    /DNOMINMAX
    /DWIN32_LEAN_AND_MEAN
)

# The prelude is needed by every file, so it's tool config rather than a line atop each file.
set(lucent_prelude "${CMAKE_CURRENT_LIST_DIR}/../core/include/lucent/core/prelude.hpp")
cmake_path(NORMAL_PATH lucent_prelude)

# lucent_library(<name> [HEADERS <public headers>...] [SOURCES <sources>...] [DEPS <targets>...])
#
# Declares lucent::<name>: public headers under include/lucent/<name>/, sources and private headers
# under src/. Every public header is compiled on its own to prove it is self-contained.
function(lucent_library name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "HEADERS;SOURCES;DEPS")
    set(target lucent_${name})
    if(arg_SOURCES)
        add_library(${target} STATIC)
        set(scope PUBLIC)
        target_sources(${target} PRIVATE ${arg_SOURCES})
    else()
        add_library(${target} INTERFACE)
        set(scope INTERFACE)
    endif()
    add_library(lucent::${name} ALIAS ${target})
    target_sources(
        ${target}
        ${scope}
        FILE_SET HEADERS
        BASE_DIRS
        include
        FILES
        ${arg_HEADERS}
    )
    set_target_properties(${target} PROPERTIES VERIFY_INTERFACE_HEADER_SETS ON)
    target_compile_options(${target} ${scope} "/FI${lucent_prelude}")
    if(NOT name STREQUAL "core")
        list(APPEND arg_DEPS lucent::core)
    endif()
    target_link_libraries(${target} ${scope} ${arg_DEPS})
endfunction()

# lucent_test(<name> SOURCES <tests>... [DEPS <targets>...])
#
# The test executable for lucent::<name>, registered with CTest under the label <name>.
function(lucent_test name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "SOURCES;DEPS")
    set(target lucent_${name}_tests)
    add_executable(${target} ${arg_SOURCES})
    target_link_libraries(${target} PRIVATE lucent::${name} lucent::testing ${arg_DEPS})
    catch_discover_tests(
        ${target}
        TEST_PREFIX "${name}: "
        PROPERTIES LABELS ${name}
        DISCOVERY_MODE PRE_TEST
    )
endfunction()
