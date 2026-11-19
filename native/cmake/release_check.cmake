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

# Configure once, then let Ninja rerun CMake when an input changed, as configure.cmake does.
if(EXISTS "${binary_dir}/build.ninja")
    set(configure
        "${CMAKE_COMMAND}"
        --build
        --preset
        release-check
        --target
        build.ninja
    )
else()
    set(configure "${CMAKE_COMMAND}" --preset release-check)
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
