# moon's native:release-check: the whole test suite built as release builds are, in its own tree.
# The fact section, fixtures and anything else the optimizer reshapes only misbehave at /O2, and
# release is what ships; a Debug-only suite let 19 such failures through unseen.
#
# A Release configure needs a master seed. This one is a throwaway: random, made once per machine
# under the ignored .moon/cache, never archived, so nothing built from it can be mistaken for a
# release.

set(source_dir "${CMAKE_CURRENT_LIST_DIR}/..")
# The release-check preset's binaryDir and LUCENT_MASTER_SEED in CMakePresets.json.
set(binary_dir "${source_dir}/../.moon/cache/cmake/release-check")
set(seed "${source_dir}/../.moon/cache/release-check.seed")

if(NOT EXISTS "${seed}")
    # 32 bytes drawn from 62 letters and digits: about 190 bits, ample for a seed nothing ships.
    string(RANDOM LENGTH 32 material)
    file(WRITE "${seed}" "${material}")
endif()

# The lease key's public half, likewise a throwaway: random bytes no server holds the seed of, so
# nothing built here accepts a real lease. Drawn once per machine, beside the seed.
set(lease_key_file "${source_dir}/../.moon/cache/release-check.lease-key")
if(NOT EXISTS "${lease_key_file}")
    set(base64url "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    string(RANDOM LENGTH 42 ALPHABET "${base64url}" lease_key_head)
    # The last character's 2 low bits are padding, zero in a canonical encoding.
    string(RANDOM LENGTH 1 ALPHABET "AEIMQUYcgkosw048" lease_key_tail)
    file(WRITE "${lease_key_file}" "${lease_key_head}${lease_key_tail}")
endif()
file(READ "${lease_key_file}" lease_key)

# Configure once, then let Ninja rerun CMake when an input changed, as configure.cmake does; a
# tree configured before it had the lease key configures again to take it.
set(cache "${binary_dir}/CMakeCache.txt")
set(has_lease_key FALSE)
if(EXISTS "${cache}")
    file(STRINGS "${cache}" cached_lease_key REGEX "^LUCENT_LEASE_PUBLIC_KEY:STRING=${lease_key}$")
    if(cached_lease_key)
        set(has_lease_key TRUE)
    endif()
endif()
if(EXISTS "${binary_dir}/build.ninja" AND has_lease_key)
    set(configure
        "${CMAKE_COMMAND}"
        --build
        --preset
        release-check
        --target
        build.ninja
    )
else()
    set(configure
        "${CMAKE_COMMAND}"
        --preset
        release-check
        "-DLUCENT_LEASE_PUBLIC_KEY=${lease_key}"
    )
endif()
execute_process(COMMAND ${configure} WORKING_DIRECTORY "${source_dir}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(
    COMMAND "${CMAKE_COMMAND}" --build --preset release-check
    WORKING_DIRECTORY "${source_dir}"
    COMMAND_ERROR_IS_FATAL ANY
)
execute_process(
    COMMAND "${CMAKE_CTEST_COMMAND}" --preset release-check
    WORKING_DIRECTORY "${source_dir}"
    COMMAND_ERROR_IS_FATAL ANY
)
