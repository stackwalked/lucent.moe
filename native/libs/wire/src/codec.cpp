#include "codec.hpp"

#include <algorithm>
#include <cstddef>
#include <expected>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/start.hpp>

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

auto writer::write_modules(std::span<const bundle::module_key> modules) -> void {
    LUCENT_INVARIANT(is_canonical_modules(modules));
    write_u8(static_cast<u8>(modules.size()));
    for (const bundle::module_key& module : modules) {
        write_u64(module.name_hash);
        write_u32(module.time_date_stamp);
        write_u32(module.size_of_image);
    }
}

auto reader::read_modules() -> result<std::vector<bundle::module_key>> {
    constexpr usize module_key_size = 16;
    const u8 count = LUCENT_TRY(read_u8());
    if (count > max_start_modules || usize{count} * module_key_size > remaining()) {
        return std::unexpected(malformed);
    }
    std::vector<bundle::module_key> modules;
    modules.reserve(count);
    for (u8 index = 0; index < count; ++index) {
        bundle::module_key module;
        module.name_hash = LUCENT_TRY(read_u64());
        module.time_date_stamp = LUCENT_TRY(read_u32());
        module.size_of_image = LUCENT_TRY(read_u32());
        modules.push_back(module);
    }
    if (!is_canonical_modules(modules)) {
        return std::unexpected(malformed);
    }
    return modules;
}

auto is_canonical_modules(std::span<const bundle::module_key> modules) -> bool {
    return modules.size() <= max_start_modules
           && std::ranges::adjacent_find(modules, std::ranges::greater_equal{}) == modules.end();
}

auto is_canonical_features(std::span<const u64> features) -> bool {
    return features.size() <= max_features
           && !std::ranges::contains(features, u64{0})
           && std::ranges::adjacent_find(features, std::ranges::greater_equal{}) == features.end();
}

}
