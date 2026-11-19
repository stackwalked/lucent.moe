// A DLL for the late-module test to load once the late worker is waiting: what it holds doesn't
// matter, only that the OS loader loads it.

extern "C" __declspec(dllexport) auto fixture_late_marker() -> int;

auto fixture_late_marker() -> int {
    return 1;
}
