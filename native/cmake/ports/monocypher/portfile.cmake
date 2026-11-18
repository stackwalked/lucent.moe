# vcpkg has no Monocypher port. Upstream ships no build system we'd use, so the port brings a
# small CMakeLists that builds the core and the standard Ed25519 add-on as one static library.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO LoupVaillant/Monocypher
    REF "${VERSION}"
    SHA512
        fdbf680d0a239410b1ac27b55dc50dc7076698766684d8deec25292cb289fe834445be8607f9aafdbeb75a4b365af39578129aeb9ecdbea4e9dc7fd0402318ac
)
file(COPY "${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt" DESTINATION "${SOURCE_PATH}")

vcpkg_cmake_configure(SOURCE_PATH "${SOURCE_PATH}")
vcpkg_cmake_install()
vcpkg_cmake_config_fixup(PACKAGE_NAME unofficial-monocypher)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENCE.md")
