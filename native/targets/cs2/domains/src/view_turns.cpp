#include <lucent/cs2-domains/view_turns.hpp>

#include <lucent/cs2-domains/mouse_model.hpp>

namespace lucent::cs2 {

auto view_turns::turn(view_turn wanted) const -> void {
    m_view->request(wanted);
}

}
