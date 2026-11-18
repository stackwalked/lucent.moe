# The compiler, linker and MSVC/SDK locations for every native build, vcpkg's port builds included
# (the triplet chainloads this file). Locations are passed as flags rather than through a VS dev
# shell, so clangd, clang-tidy and editors see exactly what the build sees.
#
# CMake includes a toolchain file again for every try_compile, so this file must stay idempotent
# and cheap; it has no include guard on purpose.

set(lucent_repo_root "${CMAKE_CURRENT_LIST_DIR}/../..")
cmake_path(NORMAL_PATH lucent_repo_root)

# The pinned tools are whatever .prototools names, read from the file rather than asked of proto:
# proto changes its output format when it detects an agent environment.
function(lucent_proto_pin tool out_var)
    file(STRINGS "${lucent_repo_root}/.prototools" line REGEX "^${tool} = \"[0-9][^\"]*\"$")
    if(NOT line)
        message(FATAL_ERROR "${tool} is not pinned in .prototools")
    endif()
    string(REGEX REPLACE "^${tool} = \"([^\"]+)\"$" "\\1" version "${line}")
    set(${out_var} "${version}" PARENT_SCOPE)
endfunction()

if(DEFINED ENV{PROTO_HOME})
    set(lucent_proto_home "$ENV{PROTO_HOME}")
else()
    set(lucent_proto_home "$ENV{USERPROFILE}/.proto")
endif()
cmake_path(CONVERT "${lucent_proto_home}" TO_CMAKE_PATH_LIST lucent_proto_home NORMALIZE)

lucent_proto_pin(llvm lucent_llvm_version)
lucent_proto_pin(ninja lucent_ninja_version)
set(lucent_llvm_bin "${lucent_proto_home}/tools/llvm/${lucent_llvm_version}/bin")
set(lucent_ninja "${lucent_proto_home}/tools/ninja/${lucent_ninja_version}/ninja.exe")
foreach(required IN ITEMS "${lucent_llvm_bin}/clang-cl.exe" "${lucent_ninja}")
    if(NOT EXISTS "${required}")
        message(FATAL_ERROR "${required} is missing; run `proto install` in the repo root")
    endif()
endforeach()

# VS supplies the STL, CRT and SDK; the compiler is ours. Below 18 the STL lacks C++23 pieces the
# dialect relies on (checked against 18.10 / MSVC 14.51).
set(lucent_vs_floor 18.0)
set(lucent_vswhere "$ENV{ProgramFiles\(x86\)}/Microsoft Visual Studio/Installer/vswhere.exe")
if(NOT EXISTS "${lucent_vswhere}")
    message(FATAL_ERROR "vswhere not found; install Visual Studio Build Tools ${lucent_vs_floor}+")
endif()
execute_process(
    COMMAND
        "${lucent_vswhere}" -latest -products * -requires
        Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format value -property installationPath
    OUTPUT_VARIABLE lucent_vs_root
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
execute_process(
    COMMAND
        "${lucent_vswhere}" -path "${lucent_vs_root}" -format value -property installationVersion
    OUTPUT_VARIABLE lucent_vs_version
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
if(NOT lucent_vs_root OR lucent_vs_version VERSION_LESS lucent_vs_floor)
    message(
        FATAL_ERROR
        "Visual Studio Build Tools ${lucent_vs_floor}+ with the C++ x64 tools is required; found "
        "'${lucent_vs_version}'"
    )
endif()
cmake_path(CONVERT "${lucent_vs_root}" TO_CMAKE_PATH_LIST lucent_vs_root NORMALIZE)

file(
    STRINGS "${lucent_vs_root}/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"
    lucent_vc_version
)
set(lucent_vc_tools "${lucent_vs_root}/VC/Tools/MSVC/${lucent_vc_version}")

# The newest installed Windows SDK that has the user-mode headers.
set(lucent_sdk_root "$ENV{ProgramFiles\(x86\)}/Windows Kits/10")
cmake_path(CONVERT "${lucent_sdk_root}" TO_CMAKE_PATH_LIST lucent_sdk_root NORMALIZE)
file(GLOB lucent_sdk_candidates LIST_DIRECTORIES true "${lucent_sdk_root}/Include/10.*")
set(lucent_sdk_version "")
foreach(candidate IN LISTS lucent_sdk_candidates)
    cmake_path(GET candidate FILENAME version)
    if(EXISTS "${candidate}/um/Windows.h" AND version VERSION_GREATER lucent_sdk_version)
        set(lucent_sdk_version "${version}")
    endif()
endforeach()
if(NOT lucent_sdk_version)
    message(FATAL_ERROR "no Windows 10+ SDK with um/Windows.h under ${lucent_sdk_root}")
endif()

set(CMAKE_C_COMPILER "${lucent_llvm_bin}/clang-cl.exe")
set(CMAKE_CXX_COMPILER "${lucent_llvm_bin}/clang-cl.exe")
set(CMAKE_LINKER "${lucent_llvm_bin}/lld-link.exe")
set(CMAKE_AR "${lucent_llvm_bin}/llvm-lib.exe")
set(CMAKE_RC_COMPILER "${lucent_llvm_bin}/llvm-rc.exe")
set(CMAKE_MT "${lucent_llvm_bin}/llvm-mt.exe")
set(CMAKE_MAKE_PROGRAM "${lucent_ninja}" CACHE FILEPATH "" FORCE)

# clang-cl takes these as two arguments (`/vctoolsdir <dir>`), lld-link as one (`/vctoolsdir:<dir>`).
# Without a cl.exe to ask, clang-cl assumes _MSC_VER 1933; toolset 14.NN ships compiler 19.NN.
string(REGEX REPLACE "^14\\." "19." lucent_msc_version "${lucent_vc_version}")
set(lucent_sysroot_compile
    "/vctoolsdir \"${lucent_vc_tools}\" /winsdkdir \"${lucent_sdk_root}\" /winsdkversion ${lucent_sdk_version} -fms-compatibility-version=${lucent_msc_version}"
)
set(lucent_sysroot_link
    "\"/vctoolsdir:${lucent_vc_tools}\" \"/winsdkdir:${lucent_sdk_root}\" /winsdkversion:${lucent_sdk_version}"
)

set(CMAKE_C_FLAGS_INIT "${lucent_sysroot_compile} /utf-8")
set(CMAKE_CXX_FLAGS_INIT "${lucent_sysroot_compile} /utf-8")
foreach(kind IN ITEMS EXE SHARED MODULE)
    set(CMAKE_${kind}_LINKER_FLAGS_INIT "${lucent_sysroot_link}")
endforeach()

# Applied to dependencies too: RTTI off everywhere keeps class names out of every binary. CMake
# appends /GR to CMAKE_CXX_FLAGS after the _INIT value, so /GR- goes in the per-config flags, which
# come later on the command line.
foreach(config IN ITEMS DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
    set(CMAKE_CXX_FLAGS_${config}_INIT "/GR-")
endforeach()

# The static CRT is the only CRT (wishlist: static CRT everywhere).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
