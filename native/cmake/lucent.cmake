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
    # LUCENT_TRY is a statement expression. Only expansion from a macro is allowed: a statement
    # expression written out in code still warns.
    -Wno-gnu-statement-expression-from-macro-expansion
    # Asks for [[clang::lifetimebound]] on every constructor taking a pointer, including ones that
    # take a kernel handle, which is no borrow.
    -Wno-lifetime-safety-suggestions
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

# lucent_module(<name> SOURCES <sources>... [DEPS <targets>...])
#
# The loadable module lucent_<name>.dll: no import library, nothing links against it. Every module
# is checked after linking for a TLS directory, which the mapper doesn't support (check_no_tls.cmake).
function(lucent_module name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "SOURCES;DEPS")
    set(target lucent_${name})
    add_library(${target} MODULE ${arg_SOURCES})
    target_link_libraries(${target} PRIVATE lucent::core ${arg_DEPS})
    add_custom_command(
        TARGET ${target}
        POST_BUILD
        COMMAND
            "${CMAKE_COMMAND}" "-DREADOBJ=${lucent_llvm_bin}/llvm-readobj.exe"
            "-DMODULE=$<TARGET_FILE:${target}>" -P
            "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/check_no_tls.cmake"
        VERBATIM
    )
endfunction()

# lucent_executable(<name> SOURCES <sources>... [DEPS <targets>...])
#
# src/ holds main.cpp and folders named for their purpose, nothing else: main reads as the
# program, the folders as its parts. Their files include each other as "<folder>/<file>.hpp".
function(lucent_executable name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "SOURCES;DEPS")
    set(source_root "${CMAKE_CURRENT_SOURCE_DIR}/src")
    file(GLOB root_files LIST_DIRECTORIES false RELATIVE "${source_root}" "${source_root}/*")
    list(REMOVE_ITEM root_files main.cpp)
    if(root_files)
        message(
            FATAL_ERROR
            "${name}: src/ holds only main.cpp; move ${root_files} into a folder beside it"
        )
    endif()
    set(target lucent_${name})
    add_executable(${target} ${arg_SOURCES})
    set_target_properties(${target} PROPERTIES OUTPUT_NAME ${name})
    target_include_directories(${target} PRIVATE "${source_root}")
    target_link_libraries(${target} PRIVATE lucent::core ${arg_DEPS})
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
