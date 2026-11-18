cmake_minimum_required(VERSION 4.5)
project(lucent LANGUAGES CXX)

include(cmake/lucent.cmake)

find_package(Catch2 3 CONFIG REQUIRED)
include(Catch)
enable_testing()

add_subdirectory(core)
add_subdirectory(testing)
add_subdirectory(kit)
add_subdirectory(targets/cs2)
add_subdirectory(tools/loader-dev)
