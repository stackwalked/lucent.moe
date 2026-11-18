# Dependencies are built by the same pinned clang-cl, statically, against the static CRT.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../clang-cl.cmake")
# clang-cl.cmake passes the MSVC and SDK locations itself; a vcvars environment would only add a
# second, possibly different, answer.
set(VCPKG_LOAD_VCVARS_ENV OFF)

# safetyhook guards two function-local statics with thread-safe initialization, which reads a CRT
# thread_local: static TLS, which a mapped module can't have. Hooks are only created and removed on
# kit's lifecycle thread, so the guard protects nothing. Checked on safetyhook 0.7.0.
if(PORT STREQUAL "safetyhook")
    set(VCPKG_C_FLAGS "")
    set(VCPKG_CXX_FLAGS "/Zc:threadSafeInit-")
endif()
