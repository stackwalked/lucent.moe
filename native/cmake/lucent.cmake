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

# The fuzz preset's switch. On, our whole tree is compiled with AddressSanitizer and libFuzzer's
# coverage instrumentation, and the preset builds only the fuzzers: tests and modules link C++
# dependencies vcpkg built without ASan. Those dependencies stay uninstrumented, on the same
# triplet: the parsers are the code under test. Off, nothing below this block changes.
set(LUCENT_FUZZ OFF CACHE BOOL "Build libFuzzer targets under AddressSanitizer (fuzz preset)")
if(LUCENT_FUZZ)
    add_compile_options(
        /fsanitize=address
        -fsanitize=fuzzer-no-link
        # LLVM ships libFuzzer built against the MSVC STL without ASan's container annotations,
        # and the STL refuses to link annotated and unannotated objects (/failifmismatch
        # annotate_string, LLVM 23.1.5). The cost: overflows into a string's or vector's spare
        # capacity go unreported; overflows past the allocation are still caught.
        /D_DISABLE_STRING_ANNOTATION
        /D_DISABLE_VECTOR_ANNOTATION
    )
    # CMake links with lld-link directly, so the runtimes clang-cl's driver would add are named
    # here: the same three, in its order (checked with `clang-cl -###` on LLVM 23.1.5).
    string(REGEX MATCH "^[0-9]+" lucent_llvm_major "${lucent_llvm_version}")
    set(lucent_clang_runtime "${lucent_llvm_bin}/../lib/clang/${lucent_llvm_major}/lib/windows")
    cmake_path(NORMAL_PATH lucent_clang_runtime)
    add_custom_target(fuzzers)
endif()

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

# The release id every container of a Release build carries: 16 bytes as 32 lowercase hex digits,
# drawn with the master seed and archived beside it. Not a secret. A Release tree configured
# without one (release-check) draws its own once, so nothing built there names a real release.
set(LUCENT_RELEASE_ID "" CACHE STRING "The release's id: 32 lowercase hex digits")
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    if(NOT LUCENT_RELEASE_ID)
        string(RANDOM LENGTH 32 ALPHABET "0123456789abcdef" drawn_release_id)
        set(LUCENT_RELEASE_ID "${drawn_release_id}" CACHE STRING "The release's id" FORCE)
        message(STATUS "LUCENT_RELEASE_ID drawn for this build tree: ${LUCENT_RELEASE_ID}")
    endif()
    # CMake's regex has no {n} repetition, so the length is checked apart.
    string(LENGTH "${LUCENT_RELEASE_ID}" release_id_length)
    if(NOT LUCENT_RELEASE_ID MATCHES "^[0-9a-f]+$" OR NOT release_id_length EQUAL 32)
        message(FATAL_ERROR "LUCENT_RELEASE_ID must be 32 lowercase hex digits")
    endif()
endif()

# lucent_module(<name> SOURCES <sources>... [DEPS <targets>...])
#
# The loadable module lucent_<name>.dll: no import library, nothing links against it. Every module
# is checked after linking for a TLS directory, which the mapper doesn't support (check_no_tls.cmake);
# a release module also for leaked fact names and the dev key.
function(lucent_module name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "SOURCES;DEPS")
    set(target lucent_${name})
    add_library(${target} MODULE ${arg_SOURCES})
    # A fixture links the same in every configuration: a Release link without /DEBUG gets lld's
    # /OPT:ICF, folding functions the tests count, find or emulate one by one.
    target_link_options(${target} PRIVATE /OPT:NOICF)
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
    # The release gate, release builds only: the image may hold no declared fact name (facts
    # check, which knows the names from the target's searches) and not this machine's dev public
    # key (devkey check). A finding fails the link step. The module's name is its finder target's.
    # Then pack writes what ships, lucent_<name>.container beside the DLL, or fails the link step
    # naming what the container can't carry; dev keeps mapping the DLL itself. A release module has no
    # lucent_boot until kit's release boot path lands: pack gets --require-boot then.
    if(CMAKE_BUILD_TYPE STREQUAL "Release")
        add_custom_command(
            TARGET ${target}
            POST_BUILD
            COMMAND lucent_facts check --target ${name} "$<TARGET_FILE:${target}>"
            COMMAND lucent_devkey check "$<TARGET_FILE:${target}>"
            COMMAND
                lucent_pack "$<TARGET_FILE:${target}>"
                "$<TARGET_FILE_DIR:${target}>/lucent_${name}.container" --release
                "${LUCENT_RELEASE_ID}"
            VERBATIM
        )
        add_dependencies(${target} lucent_facts lucent_devkey lucent_pack)
        # A changed pack relinks the module, so its container is rewritten too.
        set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS "$<TARGET_FILE:lucent_pack>")
    endif()
    set_property(GLOBAL APPEND PROPERTY lucent_modules ${target})
    get_property(is_layering_deferred GLOBAL PROPERTY lucent_layering_deferred)
    if(NOT is_layering_deferred)
        set_property(GLOBAL PROPERTY lucent_layering_deferred TRUE)
        # At the end of the top-level directory: by then every target and every link is declared.
        cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL lucent_check_module_layering)
    endif()
endfunction()

# Fails the configure, and with it the build and :check, when a module links a <target>-finders
# library, directly or through any chain of our libraries: finders are tooling, linked only by the
# generator. Checked on CMake's own link graph rather than on moon's dependsOn, which is declared
# by hand beside it and can drift from what actually links. A link inside a generator expression
# counts whatever its condition, so a finder linked in one configuration fails all of them.
function(lucent_check_module_layering)
    get_property(modules GLOBAL PROPERTY lucent_modules)
    foreach(module IN LISTS modules)
        set(queue ${module})
        set(seen ${module})
        while(queue)
            list(POP_FRONT queue current)
            if(current STREQUAL module)
                get_target_property(links ${current} LINK_LIBRARIES)
            else()
                get_target_property(links ${current} INTERFACE_LINK_LIBRARIES)
            endif()
            if(NOT links)
                continue()
            endif()
            # Every name in an entry, so `$<$<CONFIG:Debug>:x>` and `$<LINK_ONLY:x>` yield x; the
            # names that aren't targets (CONFIG, Debug, system libraries) drop out below.
            string(REGEX MATCHALL "[A-Za-z0-9_.+-]+(::[A-Za-z0-9_.+-]+)*" names "${links}")
            foreach(name IN LISTS names)
                if(NOT TARGET ${name})
                    continue()
                endif()
                get_target_property(aliased ${name} ALIASED_TARGET)
                if(aliased)
                    set(name ${aliased})
                endif()
                get_target_property(is_imported ${name} IMPORTED)
                if(is_imported OR name IN_LIST seen)
                    continue()
                endif()
                list(APPEND seen ${name})
                set(parent_of_${name} ${current})
                if(name MATCHES "-finders$")
                    set(chain ${name})
                    set(step ${current})
                    while(NOT step STREQUAL module)
                        list(PREPEND chain ${step})
                        set(step ${parent_of_${step}})
                    endwhile()
                    list(PREPEND chain ${module})
                    list(JOIN chain " -> " path)
                    message(
                        FATAL_ERROR
                        "${module} links ${name}, a finders library, which only the generator may "
                        "link: ${path}"
                    )
                endif()
                list(APPEND queue ${name})
            endforeach()
        endwhile()
    endforeach()
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

# lucent_fuzz(<name> SOURCES <fuzz targets>... [DEPS <targets>...])
#
# One libFuzzer executable per source, <name>_fuzz_<source stem>, for lucent::<name>. Each source
# defines lucent::fuzzing::run_one (<lucent/fuzzing/run_one.hpp>). Only the fuzz preset links and
# instruments them; every other build compiles the sources unlinked, so -Werror and clang-tidy
# keep them current with the parsers they call.
function(lucent_fuzz name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "SOURCES;DEPS")
    if(NOT LUCENT_FUZZ)
        add_library(lucent_${name}_fuzz OBJECT ${arg_SOURCES})
        target_link_libraries(
            lucent_${name}_fuzz
            PRIVATE lucent::${name} lucent::fuzzing ${arg_DEPS}
        )
        return()
    endif()
    foreach(source IN LISTS arg_SOURCES)
        cmake_path(GET source STEM stem)
        set(target lucent_${name}_fuzz_${stem})
        add_executable(${target} ${source})
        set_target_properties(${target} PROPERTIES OUTPUT_NAME ${name}_fuzz_${stem})
        target_link_libraries(${target} PRIVATE lucent::${name} lucent::fuzzing ${arg_DEPS})
        target_link_options(
            ${target}
            PRIVATE
                "/wholearchive:${lucent_clang_runtime}/clang_rt.fuzzer-x86_64.lib"
                "${lucent_clang_runtime}/clang_rt.asan_dynamic-x86_64.lib"
                "/wholearchive:${lucent_clang_runtime}/clang_rt.asan_static_runtime_thunk-x86_64.lib"
        )
        # The ASan runtime is a DLL; it goes beside the executable so a run needs no PATH change.
        add_custom_command(
            TARGET ${target}
            POST_BUILD
            COMMAND
                "${CMAKE_COMMAND}" -E copy_if_different
                "${lucent_clang_runtime}/clang_rt.asan_dynamic-x86_64.dll"
                "$<TARGET_FILE_DIR:${target}>"
            VERBATIM
        )
        add_dependencies(fuzzers ${target})
    endforeach()
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

# lucent_fixture(<name> <fixture> SOURCES <sources>... [RTTI])
#
# A DLL the tests of lucent::<name> read as a foreign binary, built as the code they probe is built
# rather than as ours: RTTI adds /GR. The tests find its file at the path LUCENT_FIXTURE_<FIXTURE>.
function(lucent_fixture name fixture)
    cmake_parse_arguments(PARSE_ARGV 2 arg "RTTI" "" "SOURCES")
    set(target lucent_${name}_${fixture}_fixture)
    add_library(${target} MODULE ${arg_SOURCES})
    # A fixture links the same in every configuration: a Release link without /DEBUG gets lld's
    # /OPT:ICF, folding functions the tests count, find or emulate one by one.
    target_link_options(${target} PRIVATE /OPT:NOICF)
    if(arg_RTTI)
        target_compile_options(${target} PRIVATE /GR)
    endif()
    string(TOUPPER "${fixture}" macro_suffix)
    add_dependencies(lucent_${name}_tests ${target})
    target_compile_definitions(
        lucent_${name}_tests
        PRIVATE "LUCENT_FIXTURE_${macro_suffix}=\"$<TARGET_FILE:${target}>\""
    )
endfunction()

# lucent_shaders(<name> SHADERS <file>:<profile>... [INCLUDES <dirs>...] [DEPENDS <files>...])
#
# Compiles each HLSL file under src/shaders/ with the SDK's fxc at build time (D3D11 needs DXBC;
# no runtime compiler) into <file stem>.hpp in the build tree: a constexpr std::array of its
# bytecode in lucent::<name>::shaders, named after the stem. Dev builds keep debug info and skip
# optimization; release optimizes and strips reflection and debug info. DEPENDS lists the headers
# the shaders include, since fxc reports none.
function(lucent_shaders name)
    cmake_parse_arguments(PARSE_ARGV 1 arg "" "" "SHADERS;INCLUDES;DEPENDS")
    set(fxc "${lucent_sdk_root}/bin/${lucent_sdk_version}/x64/fxc.exe")
    if(NOT EXISTS "${fxc}")
        message(FATAL_ERROR "no fxc.exe at ${fxc}")
    endif()
    set(generated "${CMAKE_CURRENT_BINARY_DIR}/shaders")
    set(include_flags "")
    foreach(directory IN LISTS arg_INCLUDES)
        list(APPEND include_flags /I "${directory}")
    endforeach()
    set(headers "")
    foreach(shader IN LISTS arg_SHADERS)
        string(REPLACE ":" ";" parts "${shader}")
        list(GET parts 0 file)
        list(GET parts 1 profile)
        cmake_path(GET file STEM stem)
        set(source "${CMAKE_CURRENT_SOURCE_DIR}/src/shaders/${file}")
        set(bytecode "${generated}/${stem}.cso")
        set(header "${generated}/lucent/${name}/shaders/${stem}.hpp")
        add_custom_command(
            OUTPUT "${header}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${generated}/lucent/${name}/shaders"
            COMMAND
                "${fxc}" /nologo /WX /Ges /T ${profile} /E main ${include_flags}
                "$<IF:$<CONFIG:Debug>,/Zi;/Od,/O3;/Qstrip_reflect;/Qstrip_debug>" /Fo "${bytecode}"
                "${source}"
            COMMAND
                "${CMAKE_COMMAND}" "-DBYTECODE=${bytecode}" "-DHEADER=${header}"
                "-DNAMESPACE=lucent::${name}::shaders" "-DVARIABLE=${stem}" "-DSOURCE=${file}" -P
                "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/embed_shader.cmake"
            DEPENDS
                "${source}"
                ${arg_DEPENDS}
                "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/embed_shader.cmake"
            COMMAND_EXPAND_LISTS
            VERBATIM
        )
        list(APPEND headers "${header}")
    endforeach()
    target_sources(lucent_${name} PRIVATE ${headers})
    target_include_directories(lucent_${name} PRIVATE "${generated}")
    add_custom_target(lucent_${name}_shaders DEPENDS ${headers})
    add_dependencies(lucent_generated lucent_${name}_shaders)
endfunction()

# Every header the build generates rather than configure, so lint (which compiles each unit through
# clang-tidy) can wait for these alone instead of the whole build: lucent_shaders and devkey add
# their steps to it.
add_custom_target(lucent_generated)

# lucent::build, the generated per-release subkeys (build_keys.cmake).
include("${CMAKE_CURRENT_LIST_DIR}/build_keys.cmake")
