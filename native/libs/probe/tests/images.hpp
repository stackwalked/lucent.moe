#pragma once

#include <string_view>

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// This test executable as the probe sees a game module: its file, read from disk.
auto own_module() -> module_file;
// An address in this running executable as an RVA.
auto own_rva(uptr address) -> u32;

// tests/fixtures/game.cpp, built with RTTI, read from disk.
auto game_module() -> module_file;

// The same fixture loaded into this process, which is the ground truth the probe's reading of the
// file is checked against.
class loaded_game final {
public:
    loaded_game();
    loaded_game(const loaded_game&) = delete ("owns a reference on the loaded module");
    auto operator=(const loaded_game&) -> loaded_game& = delete ("owns a module reference");
    loaded_game(loaded_game&&) = delete ("owns a module reference");
    auto operator=(loaded_game&&) -> loaded_game& = delete ("owns a module reference");
    ~loaded_game();

    // What the export returns: the address of one of the fixture's objects.
    auto object(std::string_view export_name) const -> uptr;
    // The vtable an object of the fixture points at, as an RVA.
    auto vtable_of(uptr object) const -> u32;

private:
    uptr m_base = 0;
};

}
