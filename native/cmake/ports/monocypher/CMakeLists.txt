cmake_minimum_required(VERSION 3.25)
project(monocypher LANGUAGES C)

add_library(monocypher STATIC src/monocypher.c src/optional/monocypher-ed25519.c)
target_include_directories(
    monocypher
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>"
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src/optional>"
        "$<INSTALL_INTERFACE:include>"
)

install(TARGETS monocypher EXPORT unofficial-monocypher-targets)
install(FILES src/monocypher.h src/optional/monocypher-ed25519.h DESTINATION include)
install(
    EXPORT unofficial-monocypher-targets
    NAMESPACE unofficial::monocypher::
    DESTINATION share/unofficial-monocypher
)
file(
    WRITE "${CMAKE_CURRENT_BINARY_DIR}/unofficial-monocypher-config.cmake"
    "include(\"\${CMAKE_CURRENT_LIST_DIR}/unofficial-monocypher-targets.cmake\")\n"
)
install(
    FILES "${CMAKE_CURRENT_BINARY_DIR}/unofficial-monocypher-config.cmake"
    DESTINATION share/unofficial-monocypher
)
