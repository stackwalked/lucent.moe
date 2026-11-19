#pragma once

namespace lucent::kit {

namespace detail {

// Defined only in kit's sources, so nothing outside kit can complete it, and with it make a token.
struct domain_token_mint;

}

// What opens access to foreign memory (read_access, write_access): the lifecycle hands one to the
// target's attach, which hands it to the domains it builds. Features get views and stage tokens,
// never this: a feature can't make one, so a feature that opens access fails to compile. The one
// other way to get one is the counted escape hatch, kit::raw::token().
class domain_token final {
private:
    friend struct detail::domain_token_mint;

    domain_token() = default;
};

}
