// A stand-in for one of our own images, for the OS loader to map and relocate: code, and constant
// data holding absolute addresses, which the loader rewrites for whatever base it picks.

#include <array>

using operation = auto (*)(int) -> int;

extern "C" {
__declspec(dllexport) auto fixture_increment(int value) -> int;
__declspec(dllexport) auto fixture_double(int value) -> int;
__declspec(dllexport) auto fixture_negate(int value) -> int;
__declspec(dllexport) extern const std::array<operation, 3> fixture_operations;
}

auto fixture_increment(int value) -> int {
    return value + 1;
}

auto fixture_double(int value) -> int {
    return value * 2;
}

auto fixture_negate(int value) -> int {
    return -value;
}

constinit const std::array<operation, 3> fixture_operations{
    &fixture_increment,
    &fixture_double,
    &fixture_negate,
};
