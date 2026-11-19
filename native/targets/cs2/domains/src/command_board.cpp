#include <lucent/cs2-domains/command_board.hpp>

#include <span>

#include <lucent/cs2-domains/command.hpp>

namespace lucent::cs2 {

auto command_board::add(stage from, const step_request& step) -> void {
    m_requests.push_back(stage_request{.from = from, .step = step});
}

auto command_board::requests() const -> std::span<const stage_request> {
    return m_requests;
}

auto command_board::clear() -> void {
    m_requests.clear();
}

}
