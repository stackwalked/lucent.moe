# The toolchain the presets name: clang-cl, then vcpkg from the same VS install. vcpkg's port builds
# chainload clang-cl.cmake alone through the triplet.
include("${CMAKE_CURRENT_LIST_DIR}/clang-cl.cmake")
include("${lucent_vs_root}/VC/vcpkg/scripts/buildsystems/vcpkg.cmake")
