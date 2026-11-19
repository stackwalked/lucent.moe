#pragma once

#include <lucent/kit/domain_token.hpp>

namespace lucent::kit::detail {

// The one maker of domain tokens: the lifecycle's, for attach, and the raw escape hatch's.
struct domain_token_mint {
    static auto mint() -> domain_token {
        return domain_token{};
    }
};

}
