#include "codec.hpp"

#include <algorithm>
#include <cstddef>
#include <expected>
#include <span>
#include <string>
#include <string_view>

#include <lucent/wire/ids.hpp>

namespace lucent::wire::detail {
namespace {

auto is_product_char(char each) -> bool {
    return (each >= 'a' && each <= 'z') || (each >= '0' && each <= '9') || each == '-';
}

auto is_product(std::string_view product) -> bool {
    return !product.empty()
           && product.size() <= max_product_size
           && std::ranges::all_of(product, is_product_char);
}

}

// A product id: u8 length, then its bytes.
auto writer::write_product(std::string_view product) -> void {
    LUCENT_INVARIANT(is_product(product));
    write_u8(static_cast<u8>(product.size()));
    write_bytes(std::as_bytes(std::span{product}));
}

auto reader::read_product() -> result<std::string> {
    const u8 size = LUCENT_TRY(read_u8());
    const std::span<const std::byte> taken = LUCENT_TRY(read_bytes(size));
    std::string product;
    for (const std::byte each : taken) {
        product.push_back(static_cast<char>(each));
    }
    if (!is_product(product)) {
        return std::unexpected(malformed);
    }
    return product;
}

}
