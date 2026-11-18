# moon's native:configure. The first run configures the dev tree; later runs only ask Ninja to
# regenerate it, which reruns CMake when a file the last configure read has changed (CMake tracks
# its list files, vcpkg its manifests, toolchain.cmake the rest) and otherwise does nothing.
# Configuring every time cost a vcpkg install check, about 3.5 s, before every build and inject.

set(source_dir "${CMAKE_CURRENT_LIST_DIR}/..")
# The dev preset's binaryDir in CMakePresets.json.
set(binary_dir "${source_dir}/../.moon/cache/cmake/dev")

if(EXISTS "${binary_dir}/build.ninja")
    execute_process(
        COMMAND "${CMAKE_COMMAND}" --build --preset dev --target build.ninja
        WORKING_DIRECTORY "${source_dir}"
        COMMAND_ERROR_IS_FATAL ANY
    )
else()
    execute_process(
        COMMAND "${CMAKE_COMMAND}" --preset dev
        WORKING_DIRECTORY "${source_dir}"
        COMMAND_ERROR_IS_FATAL ANY
    )
endif()
