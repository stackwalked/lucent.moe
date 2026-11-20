#pragma once

#include <cstddef>
#include <span>

namespace lucent::kit::detail {

// Where secret randomness comes from: the system's CSPRNG in a module, a seeded stand-in in tests.
// Any thread.
class random_source {
public:
    random_source(const random_source&) = delete ("a source is passed by reference");
    auto operator=(const random_source&) -> random_source& = delete ("passed by reference");
    random_source(random_source&&) = delete ("a source is passed by reference");
    auto operator=(random_source&&) -> random_source& = delete ("passed by reference");
    virtual ~random_source() = default;

    virtual auto fill(std::span<std::byte> out) -> result<void> = 0;

protected:
    random_source() = default;
};

// BCryptGenRandom with the system's preferred RNG.
class system_random final : public random_source {
public:
    system_random() = default;

    auto fill(std::span<std::byte> out) -> result<void> override;
};

}
