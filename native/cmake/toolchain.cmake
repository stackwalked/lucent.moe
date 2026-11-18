# The toolchain the presets name: clang-cl, then vcpkg from the same VS install. vcpkg's port builds
# chainload clang-cl.cmake alone through the triplet.
include("${CMAKE_CURRENT_LIST_DIR}/clang-cl.cmake")
include("${lucent_vs_root}/VC/vcpkg/scripts/buildsystems/vcpkg.cmake")

# Ninja reruns CMake when a file the configure read changes. CMake tracks list files and vcpkg its
# manifests; these two are read another way (file(STRINGS), and by vcpkg itself).
file(GLOB lucent_triplets "${CMAKE_CURRENT_LIST_DIR}/triplets/*.cmake")
set_property(
    DIRECTORY
    APPEND
    PROPERTY CMAKE_CONFIGURE_DEPENDS "${lucent_repo_root}/.prototools" ${lucent_triplets}
)
