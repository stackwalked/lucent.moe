#include "start/game.hpp"

#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/os/modules.hpp>

namespace lucent::loader {
namespace {

auto module_at(const char* name, const wchar_t* path) -> os::remote_module {
    return os::remote_module{.name = name, .path = path, .base = 0, .size = 0};
}

TEST_CASE("the game's modules are the ones under its install root, whatever their case") {
    const std::vector loaded{
        module_at(
            "cs2.exe",
            LR"(D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe)"
        ),
        module_at(
            "engine2.dll",
            LR"(D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\engine2.dll)"
        ),
        module_at(
            "client.dll",
            LR"(D:\STEAM\steamapps\common\Counter-Strike Global Offensive\GAME\csgo\bin\win64\client.dll)"
        ),
        module_at("kernel32.dll", LR"(C:\Windows\System32\kernel32.dll)"),
        module_at(
            "overlay.dll",
            LR"(D:\Steam\steamapps\common\Counter-Strike Global Offensive\gamex\overlay.dll)"
        ),
    };
    const std::vector<os::remote_module> found = game_modules(cs2, loaded);
    REQUIRE(found.size() == 3);
    REQUIRE(found.at(0).name == "cs2.exe");
    REQUIRE(found.at(1).name == "engine2.dll");
    REQUIRE(found.at(2).name == "client.dll");
}

TEST_CASE("without the game's executable loaded, nothing is the game's") {
    const std::vector loaded{module_at("client.dll", LR"(D:\game\csgo\bin\win64\client.dll)")};
    REQUIRE(game_modules(cs2, loaded).empty());
}

}
}
