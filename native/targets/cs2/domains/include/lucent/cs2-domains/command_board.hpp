#pragma once

#include <span>
#include <vector>

#include <lucent/cs2-domains/command.hpp>

namespace lucent::cs2 {

// The requests the stages made this tick, in the order they made them. The command domain owns
// it; the stage tokens record into it.
class command_board final {
public:
    auto add(stage from, const step_request& step) -> void;
    auto requests() const -> std::span<const stage_request>;
    auto clear() -> void;

private:
    std::vector<stage_request> m_requests;
};

}
