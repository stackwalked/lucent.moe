#include <lucent/kit/raw.hpp>

#include <lucent/kit/domain_token.hpp>

#include "domain_token_mint.hpp"

namespace lucent::kit::raw {

auto token() -> domain_token {
    return detail::domain_token_mint::mint();
}

}
