#pragma once

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// This test executable as the probe sees a game module: its file, read from disk.
auto own_module() -> module_file;

// An address in this running executable as an RVA.
auto own_rva(uptr address) -> u32;

}
