#include <lucent/cs2-features/all.hpp>

#include <lucent/cs2-features/player_box.hpp>
#include <lucent/kit/wiring.hpp>

namespace lucent::cs2::features {

auto wire(kit::wiring& features) -> void {
    features.add<player_box>();
}

}
