#pragma once

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/domain_token.hpp>

// The escape hatch from the access boundary, always spelled `raw::` so grep finds every use, and
// `:check` counts them (tools/lint/raw_count.py). A use is debt: it is promoted into a proper API
// (a fact, a capability, a domain), never left to spread.
namespace lucent::kit::raw {

// Foreign memory at addresses no fact vouches for: a raw offset, a pointer that bypasses a
// capability.
class access final {
public:
    explicit access(foreign::memory_source source)
        : m_source{source} {}

    template <foreign::plain T>
    auto read(foreign::foreign_ptr<T> pointer) const -> result<T> {
        return foreign::read(m_source, pointer);
    }

    template <foreign::plain T>
    auto write(foreign::foreign_ptr<T> pointer, T value) const -> result<void> {
        return foreign::write(m_source, pointer, value);
    }

private:
    foreign::memory_source m_source;
};

// A domain token from nowhere: for tests standing in for the lifecycle, and for code that opens
// access outside a domain.
auto token() -> domain_token;

}
