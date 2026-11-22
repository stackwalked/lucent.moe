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

# A public key's 43 base64url characters, drawn once per machine into the file and read back:
# random bytes no one holds the secret half of, so nothing built here accepts a real lease or seal.
function(throwaway_public_key file out)
    if(NOT EXISTS "${file}")
        set(base64url "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        string(RANDOM LENGTH 42 ALPHABET "${base64url}" head)
        # The last character's 2 low bits are padding, zero in a canonical encoding.
        string(RANDOM LENGTH 1 ALPHABET "AEIMQUYcgkosw048" tail)
        file(WRITE "${file}" "${head}${tail}")
    endif()
    file(READ "${file}" key)
    set(${out} "${key}" PARENT_SCOPE)
endfunction()

# The lease key's public half, which release modules verify leases against, and the code key's,
# which the release loader verifies seals against.
throwaway_public_key("${source_dir}/../.moon/cache/release-check.lease-key" lease_key)
throwaway_public_key("${source_dir}/../.moon/cache/release-check.code-key" code_key)

# Configure once, then let Ninja rerun CMake when an input changed, as configure.cmake does; a
# tree configured before it had both keys configures again to take them.
set(cache "${binary_dir}/CMakeCache.txt")
set(has_keys FALSE)
if(EXISTS "${cache}")
    file(STRINGS "${cache}" cached_lease_key REGEX "^LUCENT_LEASE_PUBLIC_KEY:STRING=${lease_key}$")
    file(STRINGS "${cache}" cached_code_key REGEX "^LUCENT_CODE_PUBLIC_KEY:STRING=${code_key}$")
    if(cached_lease_key AND cached_code_key)
        set(has_keys TRUE)
    endif()
endif()
if(EXISTS "${binary_dir}/build.ninja" AND has_keys)
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
        "-DLUCENT_CODE_PUBLIC_KEY=${code_key}"
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
