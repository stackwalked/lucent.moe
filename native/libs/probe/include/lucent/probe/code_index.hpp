#pragma once

#include <span>
#include <vector>

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// How an instruction names another place in the image.
enum class reference_kind : u8 {
    call,
    jump,
    // A conditional branch.
    branch,
    // lea: the address itself, not what it holds.
    address,
    load,
    store,
};

// An instruction at source naming target, both RVAs.
struct reference {
    u32 source = 0;
    u32 target = 0;
    reference_kind kind = reference_kind::call;

    auto operator==(const reference&) const -> bool = default;
};

// The references the code in [range.rva, range.rva + range.size) makes, in address order. Decoding
// is linear: bytes that aren't an instruction, or are int3 padding, are skipped one at a time.
auto references_in(const module_file& module, pe::rva_range range) -> std::vector<reference>;

// Every reference the module's executable sections make, looked up by target. Code .pdata lists
// is decoded function by function; the gaps between (leaf functions without unwind data, thunks)
// are swept linearly, so data placed among code can add references that aren't real.
class code_index final {
public:
    static auto build(const module_file& module) -> code_index;

    // Sorted by source.
    auto references_to(u32 target) const -> std::span<const reference>;
    auto size() const -> isize;

private:
    explicit code_index(std::vector<reference> by_target);

    std::vector<reference> m_by_target;
};

}
